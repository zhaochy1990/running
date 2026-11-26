package planeval

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zhaochy1990/stride/internal/httplog"
	"github.com/zhaochy1990/stride/internal/storage"
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

	admin := r.Group(adminPrefix, adminAuth, func(c *gin.Context) {
		limit := int64(16 << 20)
		if c.Request.Method == http.MethodPost && c.FullPath() == adminPrefix+"/rules/trial" {
			// 48 MiB CheckInput plus bounded JSON-escaped rule source and metadata.
			limit = maxRuleInputBytes + (2 << 20)
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		c.Next()
	})
	admin.GET("/agent-versions", s.handleAgentVersions)
	admin.GET("/scenarios", func(c *gin.Context) {
		rows, err := s.store.ListPlanEvalScenarios(c.Request.Context())
		if err != nil {
			writeError(c, s.internal(err))
			return
		}
		views := make([]ScenarioView, 0, len(rows))
		for _, row := range rows {
			doc, e := decodeScenario(&row)
			if e != nil {
				writeError(c, s.internal(e))
				return
			}
			views = append(views, scenarioView(doc))
		}
		c.JSON(200, gin.H{"scenarios": views})
	})
	admin.GET("/scenarios/:id", func(c *gin.Context) {
		doc, e := s.loadScenario(c.Request.Context(), c.Param("id"))
		if e != nil {
			writeError(c, e)
			return
		}
		c.JSON(200, scenarioView(doc))
	})
	saveScenario := func(c *gin.Context) {
		var req ScenarioView
		if !decode(c, &req) {
			return
		}
		view, e := s.saveScenario(c.Request.Context(), c.Param("id"), req)
		if e != nil {
			writeError(c, e)
			return
		}
		c.JSON(200, view)
	}
	admin.POST("/scenarios", saveScenario)
	admin.PUT("/scenarios/:id", saveScenario)
	admin.POST("/request-preview", func(c *gin.Context) {
		var req struct {
			ArtifactType string          `json:"artifact_type"`
			SnapshotID   string          `json:"snapshot_id"`
			Request      json.RawMessage `json:"request"`
		}
		if !decode(c, &req) {
			return
		}
		snapshot, err := s.store.GetPlanEvalRunnerSnapshot(c.Request.Context(), req.SnapshotID)
		if err != nil {
			writeError(c, s.mapStorageError(err))
			return
		}
		request, asOf, e := generationRequest(req.ArtifactType, snapshot.SnapshotJSON, string(req.Request))
		if e != nil {
			e.Detail = "数据 " + req.SnapshotID + ": " + e.Detail
			writeError(c, e)
			return
		}
		c.JSON(200, gin.H{"request": json.RawMessage(request), "as_of": asOf})
	})
	admin.GET("/snapshots", func(c *gin.Context) {
		rows, err := s.store.ListPlanEvalSnapshots(c.Request.Context())
		if err != nil {
			writeError(c, s.internal(err))
			return
		}
		views := make([]SnapshotView, 0, len(rows))
		for _, row := range rows {
			views = append(views, snapshotView(row))
		}
		c.JSON(200, gin.H{"snapshots": views})
	})
	admin.GET("/snapshots/:id", func(c *gin.Context) {
		row, err := s.store.GetPlanEvalRunnerSnapshot(c.Request.Context(), c.Param("id"))
		if err != nil {
			writeError(c, s.mapStorageError(err))
			return
		}
		c.Data(200, "application/json", []byte(row.SnapshotJSON))
	})
	saveSnapshot := func(c *gin.Context) {
		var raw json.RawMessage
		if !decode(c, &raw) {
			return
		}
		row, e := s.saveSnapshot(c.Request.Context(), c.Param("id"), raw)
		if e != nil {
			writeError(c, e)
			return
		}
		c.Data(200, "application/json", []byte(row.SnapshotJSON))
	}
	admin.POST("/snapshots", saveSnapshot)
	admin.PUT("/snapshots/:id", saveSnapshot)
	admin.GET("/rules", func(c *gin.Context) {
		rows, err := s.store.ListPlanEvalRules(c.Request.Context())
		if err != nil {
			writeError(c, s.internal(err))
			return
		}
		c.JSON(200, gin.H{"rules": rows})
	})

	admin.GET("/rules/:id/:version", func(c *gin.Context) {
		version, err := strconv.Atoi(c.Param("version"))
		if err != nil || version < 1 {
			writeError(c, fail(422, "invalid_rule", "version: 须为正整数"))
			return
		}
		rule, err := s.store.GetPlanEvalRule(c.Request.Context(), c.Param("id"), version)
		if err != nil {
			writeError(c, s.mapStorageError(err))
			return
		}
		c.JSON(200, rule)
	})
	admin.POST("/rules", func(c *gin.Context) {
		var req storage.PlanEvalRule
		if !decode(c, &req) {
			return
		}
		rule, e := s.publishRule(c.Request.Context(), req)
		if e != nil {
			writeError(c, e)
			return
		}
		c.JSON(201, rule)
	})
	admin.POST("/rules/trial", func(c *gin.Context) {
		var req ruleTrialRequest
		if !decode(c, &req) {
			return
		}
		result, e := s.trialRule(c.Request.Context(), req)
		if e != nil {
			writeError(c, e)
			return
		}
		c.JSON(200, result)
	})

	admin.POST("/agent-versions/:version/cleanup", s.handleCleanup)
	admin.POST("/agent-versions/:version/scale", s.handleScale)
	admin.POST("/tasks", func(c *gin.Context) { s.handleCreateTask(c, adminID(c)) })
	admin.GET("/tasks", s.handleListTasks)
	admin.GET("/tasks/:id", s.handleTaskDetail)
	admin.GET("/tasks/:id/executions/:execution_id/input", func(c *gin.Context) {
		input, e := s.ExecutionInput(c.Request.Context(), c.Param("id"), c.Param("execution_id"))
		if e != nil {
			writeError(c, e)
			return
		}
		c.JSON(200, input)
	})
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
		var tooLarge *http.MaxBytesError
		if c.FullPath() == adminPrefix+"/rules/trial" && errors.As(err, &tooLarge) {
			writeError(c, fail(http.StatusRequestEntityTooLarge, "request_too_large", "试跑请求须 ≤50 MiB"))
			return false
		}
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
