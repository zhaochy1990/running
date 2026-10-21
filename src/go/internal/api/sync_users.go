package api

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"
)

// SyncUserLister backs GET /api/internal/sync-users (devops#661): the distinct
// user_ids holding a provider credential — the set the daily/weekly sync
// workflows iterate. Satisfied by *storage.Store.
type SyncUserLister interface {
	ListSyncableUserIDs(ctx context.Context) ([]string, error)
}

type syncUsersResponse struct {
	Users []string `json:"users"`
	Count int      `json:"count"`
}

// listSyncUsers answers the internal caller with the syncable user list. Only
// the internal tier may call it (the GHA workflows' X-Internal-Token): user and
// admin JWTs get 403 — the list is server infrastructure, not user-visible
// data, so no broader tier ever needs it.
//
//	@Summary		List syncable users (internal)
//	@Description	Internal-only. Distinct user_ids holding a provider credential, sorted, no PII — the daily/weekly sync workflow's user list (devops#660).
//	@Tags			sync
//	@Produce		json
//	@Success		200	{object}	syncUsersResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Failure		503	{object}	errorResponse
//	@Security		InternalToken
//	@Router			/api/internal/sync-users [get]
func (s *Service) listSyncUsers(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	if s.syncUserLister == nil {
		c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "sync user lister not configured"})
		return
	}
	ids, err := s.syncUserLister.ListSyncableUserIDs(c.Request.Context())
	if err != nil {
		s.log.Error("list syncable users failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if ids == nil {
		ids = []string{}
	}
	c.JSON(http.StatusOK, syncUsersResponse{Users: ids, Count: len(ids)})
}

// SyncUserAuditor backs GET /api/internal/sync-user-orphans (devops#663): the
// credential user_ids with no live auth identity — the residue the weekly
// audit workflow alerts on. Satisfied by *storage.Store.
type SyncUserAuditor interface {
	ListOrphanSyncUsers(ctx context.Context) ([]string, error)
}

type orphanSyncUsersResponse struct {
	Orphans []string `json:"orphans"`
	Count   int      `json:"count"`
}

// listOrphanSyncUsers answers the internal caller with the orphan list. Empty
// is the steady state; any hit means a deletion path bypassed the orchestrated
// erasure (devops#595/#664) and a human must clean up per DeleteUserData
// semantics. Same internal-only tier as the sync-user list.
//
//	@Summary		List orphan sync users (internal)
//	@Description	Internal-only. Credential user_ids with no live auth identity (erasure residue); empty is steady state — the weekly audit workflow (devops#663) alerts when non-empty.
//	@Tags			sync
//	@Produce		json
//	@Success		200		{object}	orphanSyncUsersResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Failure		503		{object}	errorResponse
//	@Security		InternalToken
//	@Router			/api/internal/sync-user-orphans [get]
func (s *Service) listOrphanSyncUsers(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	if s.syncUserAuditor == nil {
		c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "sync user auditor not configured"})
		return
	}
	ids, err := s.syncUserAuditor.ListOrphanSyncUsers(c.Request.Context())
	if err != nil {
		s.log.Error("list orphan sync users failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if ids == nil {
		ids = []string{}
	}
	c.JSON(http.StatusOK, orphanSyncUsersResponse{Orphans: ids, Count: len(ids)})
}
