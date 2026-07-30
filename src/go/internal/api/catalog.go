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
