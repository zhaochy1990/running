package planeval

import (
	"context"
	"fmt"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	k8stesting "k8s.io/client-go/testing"
	"reflect"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func newFakeDeployer() *kubernetesDeployer {
	return &kubernetesDeployer{
		client:    fake.NewSimpleClientset(),
		namespace: "stride",
		options: KubernetesOptions{
			ImageRepository: "registry.example/stride/stride-coach-worker", PullSecret: "acr-regcred",
			WorkerAPIURL: "http://plan-eval-api:8080", WorkerAMQPURL: "amqp://guest:guest@rabbitmq:5672/", WorkerToken: "worker-secret",
		},
	}
}

func envMap(container corev1.Container) map[string]string {
	out := map[string]string{}
	for _, variable := range container.Env {
		out[variable.Name] = variable.Value
	}
	return out
}

func TestKubernetesDeployer_EnsureCreatesSecretThenDeployment(t *testing.T) {
	d := newFakeDeployer()
	ctx := context.Background()
	spec := WorkerSpec{AgentVersion: "2026.11.30", Replicas: 1, Env: map[string]string{"DEEPSEEK_API_KEY": "sk-live"}}

	if err := d.Ensure(ctx, spec); err != nil {
		t.Fatalf("ensure: %v", err)
	}

	secret, err := d.client.CoreV1().Secrets("stride").Get(ctx, "plan-eval-worker-2026.11.30", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("launch secret: %v", err)
	}
	// The administrator's variables and the two runtime secrets; the pod
	// template never carries a value.
	for key, want := range map[string]string{"DEEPSEEK_API_KEY": "sk-live", "PLAN_WORKER_EVAL_API_TOKEN": versionWorkerToken("worker-secret", spec.AgentVersion), "PLAN_WORKER_AMQP_URL": "amqp://guest:guest@rabbitmq:5672/"} {
		if got := string(secret.Data[key]); got != want {
			t.Errorf("secret[%s] = %q, want %q", key, got, want)
		}
	}

	deployment, err := d.client.AppsV1().Deployments("stride").Get(ctx, "plan-eval-worker-2026.11.30", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("deployment: %v", err)
	}
	if *deployment.Spec.Replicas != 1 || len(deployment.Spec.Template.Spec.Containers) != 1 {
		t.Fatalf("unexpected deployment: %+v", deployment.Spec)
	}
	container := deployment.Spec.Template.Spec.Containers[0]
	if container.Image != "registry.example/stride/stride-coach-worker:2026.11.30" {
		t.Errorf("image = %q", container.Image)
	}
	env := envMap(container)
	want := map[string]string{
		"PLAN_WORKER_MODE": "eval", "STRIDE_COACH_ENV": "prod", "PLAN_WORKER_EVAL_QUEUE": "plan.eval.execute.2026.11.30",
		"PLAN_WORKER_EVAL_AGENT_VERSION": "2026.11.30", "PLAN_WORKER_EVAL_API_BASE_URL": "http://plan-eval-api:8080",
	}
	for name, value := range want {
		if env[name] != value {
			t.Errorf("env[%s] = %q, want %q", name, env[name], value)
		}
	}
	if len(container.EnvFrom) != 1 || container.EnvFrom[0].SecretRef.Name != "plan-eval-worker-2026.11.30" {
		t.Errorf("launch variables must come from the Secret: %+v", container.EnvFrom)
	}
	if strings.Contains(deployment.Spec.Template.Spec.Containers[0].Image, "latest") {
		t.Errorf("no floating tags")
	}
	if deployment.Spec.Template.Spec.ImagePullSecrets[0].Name != "acr-regcred" {
		t.Errorf("pull secret: %+v", deployment.Spec.Template.Spec.ImagePullSecrets)
	}
	status, err := d.Status(ctx, "2026.11.30")
	if err != nil || !status.Present || status.Replicas != 1 {
		t.Fatalf("status = %+v, %v", status, err)
	}
}

func TestKubernetesDeployer_EnsureIsIdempotentAndRollsOnChangedValues(t *testing.T) {
	d := newFakeDeployer()
	ctx := context.Background()
	spec := WorkerSpec{AgentVersion: "2026.11.30", Replicas: 1, Env: map[string]string{"DEEPSEEK_API_KEY": "sk-1"}}
	if err := d.Ensure(ctx, spec); err != nil {
		t.Fatal(err)
	}
	first, _ := d.client.AppsV1().Deployments("stride").Get(ctx, "plan-eval-worker-2026.11.30", metav1.GetOptions{})

	// Same values, more replicas: only the scale changes.
	scaled := spec
	scaled.Replicas = 3
	if err := d.Ensure(ctx, scaled); err != nil {
		t.Fatal(err)
	}
	second, _ := d.client.AppsV1().Deployments("stride").Get(ctx, "plan-eval-worker-2026.11.30", metav1.GetOptions{})
	if *second.Spec.Replicas != 3 || second.Spec.Template.Annotations["plan-eval/launch-checksum"] != first.Spec.Template.Annotations["plan-eval/launch-checksum"] {
		t.Fatalf("scale-only ensure changed the template or lost the replicas: %+v", second.Spec)
	}

	// A changed value must roll the pods: the checksum follows the values.
	rotated := scaled
	rotated.Env = map[string]string{"DEEPSEEK_API_KEY": "sk-2"}
	if err := d.Ensure(ctx, rotated); err != nil {
		t.Fatal(err)
	}
	third, _ := d.client.AppsV1().Deployments("stride").Get(ctx, "plan-eval-worker-2026.11.30", metav1.GetOptions{})
	secret, _ := d.client.CoreV1().Secrets("stride").Get(ctx, "plan-eval-worker-2026.11.30", metav1.GetOptions{})
	if string(secret.Data["DEEPSEEK_API_KEY"]) != "sk-2" {
		t.Fatalf("secret not rotated: %q", secret.Data["DEEPSEEK_API_KEY"])
	}
	if third.Spec.Template.Annotations["plan-eval/launch-checksum"] == second.Spec.Template.Annotations["plan-eval/launch-checksum"] {
		t.Fatalf("rotated values did not change the pod template: nothing would roll")
	}
}

func TestKubernetesDeployer_DeleteRemovesDeploymentAndSecretIdempotently(t *testing.T) {
	d := newFakeDeployer()
	ctx := context.Background()
	if err := d.Ensure(ctx, WorkerSpec{AgentVersion: "2026.11.30", Replicas: 1, Env: map[string]string{}}); err != nil {
		t.Fatal(err)
	}
	expected, err := d.Status(ctx, "2026.11.30")
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Delete(ctx, "2026.11.30", expected); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := d.Delete(ctx, "2026.11.30", expected); err != nil {
		t.Fatalf("delete again: %v", err)
	}
	if status, err := d.Status(ctx, "2026.11.30"); err != nil || status.Present {
		t.Fatalf("status after delete = %+v, %v", status, err)
	}
	if _, err := d.client.CoreV1().Secrets("stride").Get(ctx, "plan-eval-worker-2026.11.30", metav1.GetOptions{}); err == nil {
		t.Fatalf("launch secret survived the cleanup")
	}
}

func TestDeployer_RejectsUnusableVersionsAndUnknownKinds(t *testing.T) {
	d := newFakeDeployer()
	for _, bad := range []string{"", "a b", "../x", "1.2.3/", "x" + strings.Repeat("y", 70)} {
		if validAgentVersion(bad) {
			t.Errorf("validAgentVersion(%q) = true", bad)
		}
		if err := d.Ensure(context.Background(), WorkerSpec{AgentVersion: bad, Replicas: 1}); err == nil {
			t.Errorf("Ensure(%q) succeeded", bad)
		}
	}
	if !validAgentVersion("2026.11.30") || !validAgentVersion("2026.11.30-local-e2e") {
		t.Errorf("CalVer tags must be accepted")
	}
	if _, err := NewDeployer("nomad", KubernetesOptions{}); err == nil {
		t.Errorf("unknown deployer kind accepted")
	}
	if _, err := NewDeployer("none", KubernetesOptions{}); err != nil {
		t.Errorf("none deployer: %v", err)
	}
}

func TestKubernetesDeployer_RefusesTerminatingDeployment(t *testing.T) {
	d := newFakeDeployer()
	ctx := context.Background()
	spec := WorkerSpec{AgentVersion: "2026.11.30", Replicas: 1, Env: map[string]string{}}
	if err := d.Ensure(ctx, spec); err != nil {
		t.Fatal(err)
	}
	deployment, err := d.client.AppsV1().Deployments("stride").Get(ctx, WorkerName(spec.AgentVersion), metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	now := metav1.Now()
	deployment.DeletionTimestamp = &now
	if _, err := d.client.AppsV1().Deployments("stride").Update(ctx, deployment, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := d.Ensure(ctx, spec); err == nil || !strings.Contains(err.Error(), "still being deleted") {
		t.Fatalf("terminating deployment accepted: %v", err)
	}
}

func TestKubernetesDeployer_CleanupUsesPreGateResourceRevision(t *testing.T) {
	d := newFakeDeployer()
	ctx := context.Background()
	spec := WorkerSpec{AgentVersion: "2026.11.30", Replicas: 1, Env: map[string]string{}}
	if err := d.Ensure(ctx, spec); err != nil {
		t.Fatal(err)
	}
	deployments := d.client.AppsV1().Deployments("stride")
	name := WorkerName(spec.AgentVersion)
	current, err := deployments.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	current.UID, current.ResourceVersion = "original-worker", "1"
	if _, err := deployments.Update(ctx, current, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	expected, err := d.Status(ctx, spec.AgentVersion)
	if err != nil {
		t.Fatal(err)
	}
	// A new start after the idle gate updates the same Deployment (same UID).
	current.ResourceVersion = "2"
	if _, err := deployments.Update(ctx, current, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	d.client.(*fake.Clientset).PrependReactor("delete", "deployments", func(action k8stesting.Action) (bool, runtime.Object, error) {
		preconditions := action.(k8stesting.DeleteAction).GetDeleteOptions().Preconditions
		if preconditions == nil || preconditions.UID == nil || string(*preconditions.UID) != "original-worker" || preconditions.ResourceVersion == nil || *preconditions.ResourceVersion != "1" {
			t.Fatal("cleanup re-read new identity instead of using its pre-gate revision")
		}
		return true, nil, apierrors.NewConflict(schema.GroupResource{Group: "apps", Resource: "deployments"}, name, fmt.Errorf("resourceVersion changed"))
	})
	if err := d.Delete(ctx, spec.AgentVersion, expected); err == nil {
		t.Fatal("stale cleanup deleted new worker")
	}
	if _, err := deployments.Get(ctx, name, metav1.GetOptions{}); err != nil {
		t.Fatal(err)
	}
}

func TestKubernetesDeployer_SameConfigStartChangesRuntimeRevision(t *testing.T) {
	d := newFakeDeployer()
	ctx := context.Background()
	spec := WorkerSpec{AgentVersion: "2026.11.30", Replicas: 1, Env: map[string]string{}}
	if err := d.Ensure(ctx, spec); err != nil {
		t.Fatal(err)
	}
	first, err := d.client.AppsV1().Deployments("stride").Get(ctx, WorkerName(spec.AgentVersion), metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Ensure(ctx, spec); err != nil {
		t.Fatal(err)
	}
	second, err := d.client.AppsV1().Deployments("stride").Get(ctx, WorkerName(spec.AgentVersion), metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	key := "stride-running.cn/runtime-command"
	if first.Annotations[key] == "" || first.Annotations[key] == second.Annotations[key] {
		t.Fatal("same-config start was an empty update, allowing stale cleanup")
	}
	if !reflect.DeepEqual(first.Spec.Template, second.Spec.Template) {
		t.Fatal("runtime fence unnecessarily rolled pods")
	}
}
