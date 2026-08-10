package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// listJobs godoc
//
//	@Summary		List supported job types
//	@Description	Returns every job type the system supports (hardcoded in the catalog), each with its input JSON schema and an example input. Static system metadata; no auth required.
//	@Tags			catalog
//	@Produce		json
//	@Success		200	{object}	jobCatalogResponse
//	@Router			/jobs [get]
func (s *Service) listJobs(c *gin.Context) {
	jobs := s.jobCatalog
	if jobs == nil {
		jobs = []JobCatalogEntry{}
	}
	c.JSON(http.StatusOK, jobCatalogResponse{Jobs: jobs})
}

// listPipelines godoc
//
//	@Summary		List supported pipelines
//	@Description	Returns every pipeline the system supports (hardcoded in the catalog), each with its ordered steps, input JSON schema and an example input. Static system metadata; no auth required.
//	@Tags			catalog
//	@Produce		json
//	@Success		200	{object}	pipelineCatalogResponse
//	@Router			/pipelines [get]
func (s *Service) listPipelines(c *gin.Context) {
	pipelines := s.pipelineCatalog
	if pipelines == nil {
		pipelines = []PipelineCatalogEntry{}
	}
	c.JSON(http.StatusOK, pipelineCatalogResponse{Pipelines: pipelines})
}

const (
	onboardingContractVersion = "web-onboarding-v2"
	planSetupContractVersion  = "plan-setup-v1"
)

type onboardingRouteContract struct {
	Method string `json:"method"`
	Path   string `json:"path"`
}

// onboardingWebRouteContracts is the exact BFF route set switched atomically
// during Web onboarding cutover. Keep it in the API, rather than the deploy
// workflow, so the deployed revision attests to the routes it implements.
var onboardingWebRouteContracts = []onboardingRouteContract{
	{Method: http.MethodGet, Path: "/api/users/me/profile"},
	{Method: http.MethodPost, Path: "/api/users/me/profile"},
	{Method: http.MethodPatch, Path: "/api/users/me/profile"},
	{Method: http.MethodPost, Path: "/api/users/me/watch/login"},
	{Method: http.MethodGet, Path: "/api/users/me/injuries"},
	{Method: http.MethodPost, Path: "/api/users/me/injuries"},
	{Method: http.MethodPut, Path: "/api/users/me/injuries/:injuryId"},
	{Method: http.MethodDelete, Path: "/api/users/me/injuries/:injuryId"},
	{Method: http.MethodPost, Path: "/api/:user/sync"},
	{Method: http.MethodGet, Path: "/api/pipelines/:run_id"},
	{Method: http.MethodGet, Path: "/api/jobs/:job_id"},
	{Method: http.MethodPost, Path: "/api/users/me/onboarding/complete"},
}

// onboardingReadiness is a public, static deployment contract. It proves that
// this API revision exposes every route needed by the atomic Web onboarding
// cutover without accepting user credentials or triggering any user action.
//
//	@Summary		Web onboarding cutover readiness
//	@Description	Returns the static route contract required before the Web BFF enables its Go onboarding route flags. No authentication is required and no user data is returned.
//	@Tags			catalog
//	@Produce		json
//	@Success		200	{object}	onboardingReadinessResponse
//	@Router			/readyz/onboarding [get]
func (s *Service) onboardingReadiness(c *gin.Context) {
	c.JSON(http.StatusOK, onboardingReadinessResponse{
		ContractVersion: onboardingContractVersion,
		Routes:          append([]onboardingRouteContract(nil), onboardingWebRouteContracts...),
	})
}

var planSetupRouteContracts = []onboardingRouteContract{
	{Method: http.MethodGet, Path: "/api/users/me/training-goal"},
	{Method: http.MethodPost, Path: "/api/users/me/training-goal"},
	{Method: http.MethodPost, Path: "/api/:user/sync"},
	{Method: http.MethodGet, Path: "/api/pipelines/:run_id"},
}

func (s *Service) planSetupReadiness(c *gin.Context) {
	c.JSON(http.StatusOK, planSetupReadinessResponse{
		ContractVersion: planSetupContractVersion,
		Routes:          append([]onboardingRouteContract(nil), planSetupRouteContracts...),
	})
}

type onboardingReadinessResponse struct {
	ContractVersion string                    `json:"contract_version"`
	Routes          []onboardingRouteContract `json:"routes"`
}

type planSetupReadinessResponse struct {
	ContractVersion string                    `json:"contract_version"`
	Routes          []onboardingRouteContract `json:"routes"`
}
