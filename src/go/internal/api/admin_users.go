package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"
)

// adminUserRoutes is the administrator account-erasure surface. It is mounted on
// the parent authenticated group so the admin JWT tier can reach it, but the
// handler rejects every other tier: internal callers have no bearer to forward
// to the downstream auth/coach services, and a user token must never delete
// another account.
type adminUserRoutes struct {
	eraser *accountEraser
	log    *zap.Logger
}

func newAdminUserRoutes(eraser *accountEraser, log *zap.Logger) *adminUserRoutes {
	if log == nil {
		return &adminUserRoutes{eraser: eraser}
	}
	return &adminUserRoutes{eraser: eraser, log: log}
}

// register mounts the administrator delete-user route on the parent
// authenticated group (not the default-deny child group), because the admin tier
// must be able to enter.
func (a *adminUserRoutes) register(rg *gin.RouterGroup) {
	if a.eraser == nil {
		return
	}
	rg.DELETE("/api/admin/users/:user_id", a.deleteUser)
}

// deleteUser erases one user's identity plus all STRIDE and coach data. The
// administrator's bearer is forwarded to the downstream services, which verify
// it independently.
//
//	@Summary		Delete a user and all their data as an administrator
//	@Description	Deletes the user's auth identity, coach data, STRIDE data, and on-disk data directory in order. Only the admin JWT tier may call it. The endpoint is idempotent: replaying it finishes a partially completed cleanup. A user who still owns a team is rejected with 409.
//	@Tags			admin
//	@Param			user_id	path	string	true	"Target user UUID"
//	@Success		204
//	@Failure		400	{object}	errorResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		409	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Failure		503	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/admin/users/{user_id} [delete]
func (a *adminUserRoutes) deleteUser(c *gin.Context) {
	caller := callerFrom(c)
	if caller.Tier != TierAdmin {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	target := c.Param("user_id")
	parsed, err := uuid.Parse(target)
	if err != nil || parsed.Version() != 4 || parsed.String() != target {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return
	}
	if err := a.eraser.erase(c.Request.Context(), target, caller.UserID, bearerFrom(c), true); err != nil {
		writeEraseError(c, a.log, err)
		return
	}
	c.Status(http.StatusNoContent)
}
