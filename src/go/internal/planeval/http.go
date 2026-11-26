package planeval

import (
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zhaochy1990/stride/internal/httplog"
	"go.uber.org/zap"
)

// Route prefixes. The gateway routes the admin prefix same-origin ahead of the
// generic /api/admin/* → stride-api rule; the internal prefix is reachable
// only inside the cluster.
const (
	adminPrefix       = "/api/admin/plan-eval"
	internalPrefix    = "/api/internal/plan-eval"
	workerTokenHeader = "X-Plan-Eval-Token"
)

// Router mounts the admin surface (administrator JWT) and the worker surface
// (separate worker identity). Nothing else is exposed.
func (s *Service) Router(adminAuth gin.HandlerFunc, adminID func(*gin.Context) string, workerToken string, health gin.HandlerFunc, log *zap.Logger) *gin.Engine {
	r := gin.New()
	r.Use(httplog.Middleware(log), gin.Recovery())
	r.GET("/health", health)

	admin := r.Group(adminPrefix, adminAuth)
	admin.GET("/agent-versions", s.handleAgentVersions)
	admin.POST("/agent-versions/:version/cleanup", s.handleCleanup)
	admin.POST("/agent-versions/:version/scale", s.handleScale)
	admin.POST("/tasks", func(c *gin.Context) { s.handleCreateTask(c, adminID(c)) })
	admin.GET("/tasks", s.handleListTasks)
	admin.GET("/tasks/:id", s.handleTaskDetail)
	admin.POST("/tasks/:id/retry-launch", s.handleRetryLaunch)
	admin.GET("/artifacts/:id", s.handleArtifact)

	worker := r.Group(internalPrefix, workerAuth(workerToken))
	worker.POST("/executions/claim", s.handleClaim)
	worker.POST("/executions/:id/renew", s.handleRenew)
	worker.POST("/executions/:id/result", s.handleSubmit)
	return r
}

// workerAuth admits the eval workers' own identity. An empty token admits
// nobody: a missing secret must not open the internal surface.
func workerAuth(token string) gin.HandlerFunc {
	return func(c *gin.Context) {
		presented := c.GetHeader(workerTokenHeader)
		encoded, _, _ := strings.Cut(presented, ".")
		version, err := base64.RawURLEncoding.DecodeString(encoded)
		if token == "" || err != nil || !validAgentVersion(string(version)) || subtle.ConstantTimeCompare([]byte(presented), []byte(versionWorkerToken(token, string(version)))) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Set("worker_agent_version", string(version))
		c.Next()
	}
}

func writeError(c *gin.Context, err *Error) {
	body := gin.H{"error": err.Code, "detail": err.Detail}
	for key, value := range err.Extra {
		body[key] = value
	}
	c.JSON(err.Status, body)
}

func decode(c *gin.Context, body any) bool {
	if err := c.ShouldBindJSON(body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_json", "detail": err.Error()})
		return false
	}
	return true
}

func (s *Service) handleAgentVersions(c *gin.Context) {
	versions, err := s.AgentVersions(c.Request.Context())
	if err != nil {
		writeError(c, s.internal(err))
		return
	}
	c.JSON(http.StatusOK, gin.H{"versions": versions})
}

func (s *Service) handleCreateTask(c *gin.Context, submitter string) {
	var req CreateTaskRequest
	if !decode(c, &req) {
		return
	}
	view, replayed, err := s.CreateTask(c.Request.Context(), submitter, c.GetHeader("Idempotency-Key"), req)
	if err != nil {
		writeError(c, err)
		return
	}
	// 200 = an existing task answered the same idempotency key; 201 = created.
	status := http.StatusCreated
	if replayed {
		status = http.StatusOK
	}
	c.JSON(status, view)
}

func (s *Service) handleListTasks(c *gin.Context) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	tasks, total, err := s.ListTasks(c.Request.Context(), limit, offset)
	if err != nil {
		writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"tasks": tasks, "total": total, "limit": limit, "offset": offset})
}

func (s *Service) handleTaskDetail(c *gin.Context) {
	view, err := s.TaskDetail(c.Request.Context(), c.Param("id"))
	if err != nil {
		writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func (s *Service) handleRetryLaunch(c *gin.Context) {
	view, err := s.RetryLaunch(c.Request.Context(), c.Param("id"))
	if err != nil {
		writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func (s *Service) handleArtifact(c *gin.Context) {
	artifact, err := s.Artifact(c.Request.Context(), c.Param("id"))
	if err != nil {
		writeError(c, err)
		return
	}
	c.Header("X-Plan-Eval-Sha256", artifact.Sha256)
	c.Header("X-Plan-Eval-Artifact-Type", artifact.ArtifactType)
	c.Data(http.StatusOK, "application/json; charset=utf-8", []byte(artifact.Content))
}

func (s *Service) handleCleanup(c *gin.Context) {
	if err := s.Cleanup(c.Request.Context(), c.Param("version")); err != nil {
		writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"agent_version": c.Param("version"), "deleted": true})
}

func (s *Service) handleClaim(c *gin.Context) {
	var req claimRequest
	if !decode(c, &req) {
		return
	}
	if req.AgentVersion != c.GetString("worker_agent_version") {
		writeError(c, fail(409, "agent_version_mismatch", "凭据不属于请求的 Agent 版本"))
		return
	}

	body, err := s.Claim(c.Request.Context(), req)
	if err != nil {
		writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, body)
}

func (s *Service) handleRenew(c *gin.Context) {
	var req renewRequest
	if !decode(c, &req) {
		return
	}
	if req.AgentVersion != c.GetString("worker_agent_version") {
		writeError(c, fail(409, "agent_version_mismatch", "凭据不属于请求的 Agent 版本"))
		return
	}

	body, err := s.Renew(c.Request.Context(), c.Param("id"), req)
	if err != nil {
		writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, body)
}

func (s *Service) handleSubmit(c *gin.Context) {
	var req submitRequest
	if !decode(c, &req) {
		return
	}
	if req.AgentVersion != c.GetString("worker_agent_version") {
		writeError(c, fail(409, "agent_version_mismatch", "凭据不属于请求的 Agent 版本"))
		return
	}

	body, err := s.Submit(c.Request.Context(), c.Param("id"), req)
	if err != nil {
		writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, body)
}

func (s *Service) handleScale(c *gin.Context) {
	var req struct {
		Replicas int `json:"replicas"`
	}
	if !decode(c, &req) {
		return
	}
	if err := s.Scale(c.Request.Context(), c.Param("version"), req.Replicas); err != nil {
		writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"agent_version": c.Param("version"), "replicas": req.Replicas})
}
