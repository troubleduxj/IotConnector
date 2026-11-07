//go:build linux

package main

import (
	"strings"
	"testing"
)

func TestSystemdUnitIsHardenedAndQuoted(t *testing.T) {
	unit := systemdUnit(serviceOptions{name: "fb1", user: "fbsvc", exe: "/opt/fb/factory bridge", dataDir: "/var/lib/fb 1",
		runArgs: []string{"--host", "0.0.0.0", "--allow-cidr", "10.0.0.0/8"}})
	for _, want := range []string{
		`ExecStart="/opt/fb/factory bridge" "run" "--data-dir" "/var/lib/fb 1" "--host" "0.0.0.0" "--allow-cidr" "10.0.0.0/8"`,
		"User=fbsvc", "ProtectSystem=strict", `ReadWritePaths="/var/lib/fb 1"`, "NoNewPrivileges=true", "KillSignal=SIGINT",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit missing %q:\n%s", want, unit)
		}
	}
	if systemdQuote(`a"b$c%d`) != `"a\"b$$c%%d"` {
		t.Fatalf("quote: %s", systemdQuote(`a"b$c%d`))
	}
}
