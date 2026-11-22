package api

import (
	_ "embed"
	"net/http"

	"github.com/gin-gonic/gin"
)

// The generic course profiles were imported from KG Running Club (d09fdb5).
// They are calculator reference data with no association to a race edition.
//
//go:embed pace_race_templates.json
var paceRaceTemplates []byte

func getPaceRaceTemplates(c *gin.Context) {
	c.Header("Cache-Control", "public, max-age=3600")
	c.Data(http.StatusOK, "application/json; charset=utf-8", paceRaceTemplates)
}
