package job

import "fmt"

// Registry maps a job_type to its Handler. Handlers register at startup; the
// registry is read-only once the worker is running.
type Registry struct {
	handlers map[string]Handler
}

// NewRegistry returns an empty Registry.
func NewRegistry() *Registry {
	return &Registry{handlers: make(map[string]Handler)}
}

// Register binds a handler to jobType. It errors on a duplicate registration so
// two handlers can never silently claim the same type.
func (r *Registry) Register(jobType string, h Handler) error {
	if jobType == "" {
		return fmt.Errorf("job type must not be empty")
	}
	if _, exists := r.handlers[jobType]; exists {
		return fmt.Errorf("duplicate handler for job type %q", jobType)
	}
	r.handlers[jobType] = h
	return nil
}

// MustRegister is Register that panics on error (for package-init registration).
func (r *Registry) MustRegister(jobType string, h Handler) {
	if err := r.Register(jobType, h); err != nil {
		panic(err)
	}
}

// Handler looks up the handler for jobType.
func (r *Registry) Handler(jobType string) (Handler, bool) {
	h, ok := r.handlers[jobType]
	return h, ok
}

// Types returns the registered job types (order unspecified).
func (r *Registry) Types() []string {
	out := make([]string, 0, len(r.handlers))
	for t := range r.handlers {
		out = append(out, t)
	}
	return out
}
