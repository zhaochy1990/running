package planeval

import (
	"context"
	"fmt"
	"regexp"
)

// WorkerSpec is what one agent version's eval workers run with.
type WorkerSpec struct {
	AgentVersion    string
	Replicas        int
	RuntimeRevision uint64
	// Env holds the administrator-supplied variables (model API keys).
	Env map[string]string

	// A missing Kubernetes object has no revision to compare. Confirm that
	// its launch is still current before creating it.
	checkCreate func(context.Context) error
}

// DeploymentStatus is the evaluated worker Deployment of one version.
type DeploymentStatus struct {
	// Cleanup uses these identities after reserving the version for deletion.
	DeploymentUID             string
	DeploymentResourceVersion string
	DeploymentRevision        uint64
	SecretUID                 string
	SecretResourceVersion     string
	SecretRevision            uint64
	SecretPresent             bool
	Present                   bool
	Replicas                  int32
	ReadyReplicas             int32
}

// Deployer starts, scales and removes the eval worker Deployment of an agent
// version. The scheduler coordinates per version; this is the only component
// that talks to the cluster.
type Deployer interface {
	Ensure(ctx context.Context, spec WorkerSpec) error
	Scale(ctx context.Context, agentVersion string, replicas int, runtimeRevision uint64) error
	Delete(ctx context.Context, agentVersion string, expected DeploymentStatus) error
	Status(ctx context.Context, agentVersion string) (DeploymentStatus, error)
}

// WorkerName is the Deployment (and launch Secret) name of one version. The
// version is a CalVer tag, so the name is a valid Kubernetes name.
func WorkerName(agentVersion string) string { return "plan-eval-worker-" + agentVersion }

// agentVersionPattern is what may become a queue name, a Kubernetes object
// name and an image tag all at once.
var agentVersionPattern = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._-]{0,62}$`)

// validAgentVersion reports whether v is usable as an object name and tag.
func validAgentVersion(v string) bool { return agentVersionPattern.MatchString(v) }

// noopDeployer publishes-only deployments (`deployer: none`): workers are
// started by hand. It keeps local runs and tests free of a cluster.
type noopDeployer struct{}

func (noopDeployer) Ensure(context.Context, WorkerSpec) error               { return nil }
func (noopDeployer) Scale(context.Context, string, int, uint64) error       { return nil }
func (noopDeployer) Delete(context.Context, string, DeploymentStatus) error { return nil }
func (noopDeployer) Status(context.Context, string) (DeploymentStatus, error) {
	return DeploymentStatus{}, nil
}

// NewDeployer builds the configured deployer.
func NewDeployer(kind string, options KubernetesOptions) (Deployer, error) {
	switch kind {
	case "none":
		return noopDeployer{}, nil
	case "kubernetes":
		return newKubernetesDeployer(options)
	}
	return nil, fmt.Errorf("plan-eval deployer %q is not supported (kubernetes | none)", kind)
}
