package planeval

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"k8s.io/utils/ptr"
	"os"
	"sort"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	appsv1client "k8s.io/client-go/kubernetes/typed/apps/v1"
	corev1client "k8s.io/client-go/kubernetes/typed/core/v1"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

// KubernetesOptions configures the in-cluster deployer.
type KubernetesOptions struct {
	ImageRepository string
	// PullSecret names the imagePullSecrets entry for eval workers ("" = none).
	PullSecret string
	// WorkerAPIURL / WorkerAMQPURL / WorkerToken are injected into every eval
	// worker Deployment; the latter two are secrets and travel in its launch
	// Secret rather than in the pod template.
	WorkerAPIURL  string
	WorkerAMQPURL string
	WorkerToken   string
	// Namespace overrides the namespace used by the current Kubernetes identity.
	Namespace string
}

// k8sClientset is the slice of the Kubernetes API the deployer needs; the real
// clientset and the test fake both satisfy it.
type k8sClientset interface {
	AppsV1() appsv1client.AppsV1Interface
	CoreV1() corev1client.CoreV1Interface
}

type kubernetesDeployer struct {
	client    k8sClientset
	namespace string
	options   KubernetesOptions
}

func newKubernetesDeployer(options KubernetesOptions) (Deployer, error) {
	config, namespace, err := restConfig(options.Namespace)
	if err != nil {
		return nil, err
	}
	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("plan-eval kubernetes client: %w", err)
	}
	return &kubernetesDeployer{client: client, namespace: namespace, options: options}, nil
}

// restConfig prefers the pod's ServiceAccount; outside a cluster it falls back
// to the default kubeconfig.
func restConfig(namespaceOverride string) (*rest.Config, string, error) {
	if config, err := rest.InClusterConfig(); err == nil {
		if namespaceOverride != "" {
			return config, namespaceOverride, nil
		}
		raw, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace")
		if err != nil {
			return nil, "", fmt.Errorf("plan-eval: read the ServiceAccount namespace: %w", err)
		}
		return config, strings.TrimSpace(string(raw)), nil
	}
	loader := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		clientcmd.NewDefaultClientConfigLoadingRules(),
		&clientcmd.ConfigOverrides{Context: clientcmdapi.Context{Namespace: namespaceOverride}},
	)
	config, err := loader.ClientConfig()
	if err != nil {
		return nil, "", fmt.Errorf("plan-eval: no Kubernetes configuration (in-cluster ServiceAccount or kubeconfig): %w", err)
	}
	namespace, _, err := loader.Namespace()
	if err != nil {
		return nil, "", err
	}
	return config, namespace, nil
}

// workerLabels select every object of one version's eval workers.
func workerLabels(agentVersion string) map[string]string {
	return map[string]string{
		"app":                          WorkerName(agentVersion),
		"app.kubernetes.io/managed-by": "plan-eval",
		"plan-eval.agent-version":      agentVersion,
	}
}

// Ensure creates or updates the version's launch Secret and worker Deployment.
// The Secret is written first so a rolling pod always finds its variables; the
// pod template carries the Secret's checksum, so changed values roll the pods.
func (d *kubernetesDeployer) Ensure(ctx context.Context, spec WorkerSpec) error {
	if !validAgentVersion(spec.AgentVersion) {
		return fmt.Errorf("plan-eval: agent version %q is not usable as an object name", spec.AgentVersion)
	}
	name := WorkerName(spec.AgentVersion)
	launch := make(map[string]string, len(spec.Env)+2)
	for key, value := range spec.Env {
		launch[key] = value
	}
	launch["PLAN_WORKER_AMQP_URL"] = d.options.WorkerAMQPURL
	launch["PLAN_WORKER_EVAL_API_TOKEN"] = versionWorkerToken(d.options.WorkerToken, spec.AgentVersion)
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: d.namespace, Labels: workerLabels(spec.AgentVersion)},
		Type:       corev1.SecretTypeOpaque,
		Data:       secretData(launch),
	}
	if err := upsertSecret(ctx, d.client, d.namespace, secret); err != nil {
		return fmt.Errorf("plan-eval: ensure launch secret %s: %w", name, err)
	}

	deployment := d.deployment(spec, launchChecksum(launch))
	deployments := d.client.AppsV1().Deployments(d.namespace)
	_, err := deployments.Create(ctx, deployment, metav1.CreateOptions{})
	switch {
	case err == nil:
		return nil
	case !k8serrors.IsAlreadyExists(err):
		return fmt.Errorf("plan-eval: create deployment %s: %w", name, err)
	}
	current, err := deployments.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return fmt.Errorf("plan-eval: get deployment %s: %w", name, err)
	}
	if current.DeletionTimestamp != nil {
		return fmt.Errorf("plan-eval: deployment %s is still being deleted; retry launch after deletion", name)
	}
	current.Spec.Replicas = deployment.Spec.Replicas
	current.Spec.Template = deployment.Spec.Template
	if _, err := deployments.Update(ctx, current, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("plan-eval: update deployment %s: %w", name, err)
	}
	return nil
}

func (d *kubernetesDeployer) deployment(spec WorkerSpec, checksum string) *appsv1.Deployment {
	version := spec.AgentVersion
	replicas := int32(spec.Replicas)
	podSpec := corev1.PodSpec{
		Containers: []corev1.Container{{
			Name:  "stride-coach-worker",
			Image: d.options.ImageRepository + ":" + version,
			// The explicit mode switch takes effect before any dependency is
			// initialised (devops#1047); the queue and version bind this pod
			// to its own queue.
			Env: []corev1.EnvVar{
				{Name: "STRIDE_COACH_ENV", Value: "prod"},
				{Name: "PLAN_WORKER_MODE", Value: "eval"},
				{Name: "PLAN_WORKER_EVAL_QUEUE", Value: QueueName(version)},
				{Name: "PLAN_WORKER_EVAL_AGENT_VERSION", Value: version},
				{Name: "PLAN_WORKER_EVAL_API_BASE_URL", Value: d.options.WorkerAPIURL},
			},
			// The administrator's variables (model API keys) and the two
			// runtime secrets arrive from the launch Secret.
			EnvFrom: []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{
				LocalObjectReference: corev1.LocalObjectReference{Name: WorkerName(version)},
			}}},
			Resources: corev1.ResourceRequirements{
				Requests: corev1.ResourceList{"cpu": resource.MustParse("50m"), "memory": resource.MustParse("256Mi")},
				Limits:   corev1.ResourceList{"memory": resource.MustParse("1Gi")},
			},
		}},
	}
	if d.options.PullSecret != "" {
		podSpec.ImagePullSecrets = []corev1.LocalObjectReference{{Name: d.options.PullSecret}}
	}
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: WorkerName(version), Namespace: d.namespace, Labels: workerLabels(version)},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": WorkerName(version)}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels:      workerLabels(version),
					Annotations: map[string]string{"plan-eval/launch-checksum": checksum},
				},
				Spec: podSpec,
			},
		},
	}
}

// Delete removes the version's worker Deployment and launch Secret. The queue
// is deliberately kept: it is reused the next time this version is evaluated.
func (d *kubernetesDeployer) Delete(ctx context.Context, agentVersion string) error {
	if !validAgentVersion(agentVersion) {
		return fmt.Errorf("plan-eval: agent version %q is not usable as an object name", agentVersion)
	}

	name := WorkerName(agentVersion)
	deployments := d.client.AppsV1().Deployments(d.namespace)
	secrets := d.client.CoreV1().Secrets(d.namespace)
	deployment, err := deployments.Get(ctx, name, metav1.GetOptions{})
	if err != nil && !k8serrors.IsNotFound(err) {
		return err
	}
	secret, secretErr := secrets.Get(ctx, name, metav1.GetOptions{})
	if secretErr != nil && !k8serrors.IsNotFound(secretErr) {
		return secretErr
	}
	if err == nil {
		options := metav1.DeleteOptions{PropagationPolicy: ptr.To(metav1.DeletePropagationForeground), Preconditions: &metav1.Preconditions{UID: &deployment.UID, ResourceVersion: &deployment.ResourceVersion}}
		if err := deployments.Delete(ctx, name, options); err != nil && !k8serrors.IsNotFound(err) {
			return fmt.Errorf("plan-eval: delete deployment %s: %w", name, err)
		}
		// Wait for foreground deletion before releasing the version coordination lock.
		for {
			_, err := deployments.Get(ctx, name, metav1.GetOptions{})
			if k8serrors.IsNotFound(err) {
				break
			}
			if err != nil {
				return fmt.Errorf("plan-eval: wait for deletion %s: %w", name, err)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(200 * time.Millisecond):
			}
		}
	}
	if secretErr == nil {
		options := metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &secret.UID, ResourceVersion: &secret.ResourceVersion}}
		if err := secrets.Delete(ctx, name, options); err != nil && !k8serrors.IsNotFound(err) {
			return fmt.Errorf("plan-eval: delete launch secret %s: %w", name, err)
		}
	}
	return nil
}

func (d *kubernetesDeployer) Status(ctx context.Context, agentVersion string) (DeploymentStatus, error) {
	if !validAgentVersion(agentVersion) {
		return DeploymentStatus{}, fmt.Errorf("plan-eval: agent version %q is not usable as an object name", agentVersion)
	}
	deployment, err := d.client.AppsV1().Deployments(d.namespace).Get(ctx, WorkerName(agentVersion), metav1.GetOptions{})
	if k8serrors.IsNotFound(err) {
		return DeploymentStatus{}, nil
	}
	if err != nil {
		return DeploymentStatus{}, fmt.Errorf("plan-eval: get deployment: %w", err)
	}
	status := DeploymentStatus{Present: true, Replicas: deployment.Status.Replicas, ReadyReplicas: deployment.Status.ReadyReplicas}
	if deployment.Spec.Replicas != nil {
		status.Replicas = *deployment.Spec.Replicas
	}
	return status, nil
}

func upsertSecret(ctx context.Context, client k8sClientset, namespace string, secret *corev1.Secret) error {
	secrets := client.CoreV1().Secrets(namespace)
	_, err := secrets.Create(ctx, secret, metav1.CreateOptions{})
	if err == nil {
		return nil
	}
	if !k8serrors.IsAlreadyExists(err) {
		return err
	}
	current, err := secrets.Get(ctx, secret.Name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	// StringData is write-only; the server merges it into Data. Clearing Data
	// drops variables the administrator removed.
	// Replace the whole set: a variable the administrator dropped goes away.
	current.Data = secret.Data
	current.StringData = nil
	current.Labels = secret.Labels
	_, err = secrets.Update(ctx, current, metav1.UpdateOptions{})
	return err
}

// secretData is the explicit Data form, so nothing depends on the server's
// StringData merge.
func secretData(launch map[string]string) map[string][]byte {
	data := make(map[string][]byte, len(launch))
	for key, value := range launch {
		data[key] = []byte(value)
	}
	return data
}

// launchChecksum fingerprints the launch variables (values included) without
// exposing them.
func launchChecksum(launch map[string]string) string {
	keys := make([]string, 0, len(launch))
	for key := range launch {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	hash := sha256.New()
	for _, key := range keys {
		fmt.Fprintf(hash, "%s=%s\n", key, launch[key])
	}
	return hex.EncodeToString(hash.Sum(nil))[:16]
}
