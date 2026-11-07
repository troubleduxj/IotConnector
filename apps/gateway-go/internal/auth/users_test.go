package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/factorybridge/iotconnector/gateway-go/internal/db"
	"golang.org/x/crypto/bcrypt"
)

const strongPassword = "Str0ng-Passw0rd!"

func newTestStore(t *testing.T) *UserStore {
	t.Helper()
	database, err := db.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	return NewUserStore(database, UserStoreOptions{MaxFailures: 3, LockFor: time.Minute})
}

func TestRoleRanking(t *testing.T) {
	if !RoleAtLeast(RoleAdmin, RoleEngineer) || !RoleAtLeast(RoleEngineer, RoleOperator) || RoleAtLeast(RoleOperator, RoleEngineer) {
		t.Fatal("role order wrong")
	}
	if RoleAtLeast("root", RoleViewer) || RoleAtLeast(RoleAdmin, "root") {
		t.Fatal("unknown role satisfied a check")
	}
}

func TestLoginAndAuthenticate(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	if _, err := s.CreateUser(ctx, "alice", strongPassword, RoleOperator, false); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Login(ctx, "alice", "wrong", "", ""); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password err=%v", err)
	}
	if _, _, err := s.Login(ctx, "nobody", "x", "", ""); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("unknown user err=%v (must not reveal existence)", err)
	}
	token, p, err := s.Login(ctx, "ALICE", strongPassword, "10.0.0.1", "test")
	if err != nil || p.Role != RoleOperator {
		t.Fatalf("login p=%+v err=%v", p, err)
	}
	got, ok := s.Authenticate(ctx, token)
	if !ok || got.Username != "alice" || got.Role != RoleOperator {
		t.Fatalf("authenticate got=%+v ok=%v", got, ok)
	}
	s.Logout(ctx, token)
	if _, ok := s.Authenticate(ctx, token); ok {
		t.Fatal("token valid after logout")
	}
}

// 回归 Node D5：改角色、重置口令、禁用、删除后，旧会话必须立即失效。
func TestSessionsInvalidatedByAdminChanges(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	if _, err := s.CreateUser(ctx, "root", strongPassword, RoleAdmin, false); err != nil {
		t.Fatal(err)
	}
	user, _ := s.CreateUser(ctx, "bob", strongPassword, RoleEngineer, false)

	login := func() string {
		token, _, err := s.Login(ctx, "bob", strongPassword, "", "")
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	viewer := RoleViewer
	token := login()
	if _, err := s.UpdateUser(ctx, user.ID, UserPatch{Role: &viewer}); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Authenticate(ctx, token); ok {
		t.Fatal("session survived role change")
	}

	token = login()
	disabled := true
	if _, err := s.UpdateUser(ctx, user.ID, UserPatch{Disabled: &disabled}); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Authenticate(ctx, token); ok {
		t.Fatal("session survived disable")
	}
	if _, _, err := s.Login(ctx, "bob", strongPassword, "", ""); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatal("disabled user could log in")
	}
	enabled := false
	_, _ = s.UpdateUser(ctx, user.ID, UserPatch{Disabled: &enabled})

	token = login()
	reset := "Reset-Passw0rd!!"
	if _, err := s.UpdateUser(ctx, user.ID, UserPatch{Password: &reset}); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Authenticate(ctx, token); ok {
		t.Fatal("session survived password reset")
	}
	newToken, p, err := s.Login(ctx, "bob", reset, "", "")
	if err != nil || !p.MustChangePassword {
		t.Fatalf("admin reset must force change: p=%+v err=%v", p, err)
	}
	if err := s.DeleteUser(ctx, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Authenticate(ctx, newToken); ok {
		t.Fatal("session survived user delete")
	}
}

func TestLockoutAfterRepeatedFailures(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	user, _ := s.CreateUser(ctx, "carol", strongPassword, RoleViewer, false)
	for i := 0; i < 3; i++ {
		_, _, _ = s.Login(ctx, "carol", "wrong", "", "")
	}
	if _, _, err := s.Login(ctx, "carol", strongPassword, "", ""); !errors.Is(err, ErrLocked) {
		t.Fatalf("expected lock, err=%v", err)
	}
	s.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	if _, _, err := s.Login(ctx, "carol", strongPassword, "", ""); err != nil {
		t.Fatalf("lock did not expire: %v", err)
	}
	s.now = time.Now
	for i := 0; i < 3; i++ {
		_, _, _ = s.Login(ctx, "carol", "wrong", "", "")
	}
	if err := s.Unlock(ctx, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Login(ctx, "carol", strongPassword, "", ""); err != nil {
		t.Fatalf("unlock did not clear: %v", err)
	}
}

func TestLastAdminIsProtected(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	admin, _ := s.CreateUser(ctx, "root", strongPassword, RoleAdmin, false)
	viewer := RoleViewer
	disabled := true
	if _, err := s.UpdateUser(ctx, admin.ID, UserPatch{Role: &viewer}); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("demote last admin err=%v", err)
	}
	if _, err := s.UpdateUser(ctx, admin.ID, UserPatch{Disabled: &disabled}); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("disable last admin err=%v", err)
	}
	if err := s.DeleteUser(ctx, admin.ID); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("delete last admin err=%v", err)
	}
	if _, err := s.CreateUser(ctx, "root2", strongPassword, RoleAdmin, false); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteUser(ctx, admin.ID); err != nil {
		t.Fatalf("delete with another admin present: %v", err)
	}
}

func TestChangeOwnPasswordKeepsCurrentSessionOnly(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	_, _ = s.CreateUser(ctx, "dave", strongPassword, RoleOperator, true)
	current, p, _ := s.Login(ctx, "dave", strongPassword, "", "")
	if !p.MustChangePassword {
		t.Fatal("mustChange flag lost")
	}
	other, _, _ := s.Login(ctx, "dave", strongPassword, "", "")

	if err := s.ChangeOwnPassword(ctx, current, "wrong", "Another-Passw0rd!"); err == nil {
		t.Fatal("accepted wrong current password")
	}
	if err := s.ChangeOwnPassword(ctx, current, strongPassword, "Dave-Passw0rd-1!"); err == nil {
		t.Fatal("accepted password containing username")
	}
	if err := s.ChangeOwnPassword(ctx, current, strongPassword, "Another-Passw0rd!"); err != nil {
		t.Fatal(err)
	}
	if got, ok := s.Authenticate(ctx, current); !ok || got.MustChangePassword {
		t.Fatalf("current session lost or still flagged: %+v ok=%v", got, ok)
	}
	if _, ok := s.Authenticate(ctx, other); ok {
		t.Fatal("other session survived own password change")
	}
}

func TestImportUserKeepsBcryptHash(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	hash, _ := bcrypt.GenerateFromPassword([]byte("legacy-pass"), bcrypt.MinCost)
	if _, err := s.ImportUser(ctx, "admin", string(hash), RoleAdmin, false); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Login(ctx, "admin", "legacy-pass", "", ""); err != nil {
		t.Fatalf("imported hash not usable: %v", err)
	}
	if _, err := s.ImportUser(ctx, "x", "salt:scrypt-hex", RoleViewer, false); err == nil {
		t.Fatal("non-bcrypt hash accepted")
	}
}

func TestSessionListAndRevoke(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	_, _ = s.CreateUser(ctx, "erin", strongPassword, RoleViewer, false)
	token, p, _ := s.Login(ctx, "erin", strongPassword, "10.1.1.1", "ua")
	list, err := s.ListSessions(ctx)
	if err != nil || len(list) != 1 || list[0].ID != p.SessionID || list[0].ClientIP != "10.1.1.1" {
		t.Fatalf("list=%+v err=%v", list, err)
	}
	if ok, _ := s.RevokeSession(ctx, "zz"); ok {
		t.Fatal("malformed id revoked something")
	}
	if ok, err := s.RevokeSession(ctx, p.SessionID); !ok || err != nil {
		t.Fatalf("revoke ok=%v err=%v", ok, err)
	}
	if _, ok := s.Authenticate(ctx, token); ok {
		t.Fatal("revoked session still valid")
	}
}

func TestExpiredSessionRejected(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	_, _ = s.CreateUser(ctx, "fay", strongPassword, RoleViewer, false)
	token, _, _ := s.Login(ctx, "fay", strongPassword, "", "")
	s.now = func() time.Time { return time.Now().Add(9 * time.Hour) }
	if _, ok := s.Authenticate(ctx, token); ok {
		t.Fatal("expired session accepted")
	}
}
