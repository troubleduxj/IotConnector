package main

import (
	"crypto/tls"
	"crypto/x509"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
)

func TestSelfSignedCertIsCreatedOnceAndReused(t *testing.T) {
	dir := t.TempDir()
	first, path, selfSigned, err := loadOrCreateCert("", "", dir, "0.0.0.0")
	if err != nil || !selfSigned {
		t.Fatalf("create: selfSigned=%v err=%v", selfSigned, err)
	}
	info, err := os.Stat(filepath.Join(dir, "tls", "selfsigned.key"))
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 && os.PathSeparator == '/' {
		t.Fatalf("private key readable by others: %v", mode)
	}
	second, path2, _, err := loadOrCreateCert("", "", dir, "0.0.0.0")
	if err != nil || path2 != path || string(first.Certificate[0]) != string(second.Certificate[0]) {
		t.Fatalf("certificate not reused: err=%v", err)
	}
	leaf, _ := x509.ParseCertificate(first.Certificate[0])
	if err := leaf.VerifyHostname("localhost"); err != nil {
		t.Fatalf("cert does not cover localhost: %v", err)
	}
	if err := leaf.VerifyHostname("127.0.0.1"); err != nil {
		t.Fatalf("cert does not cover 127.0.0.1: %v", err)
	}
}

func TestCertFlagsMustBePaired(t *testing.T) {
	if _, _, _, err := loadOrCreateCert("a.crt", "", t.TempDir(), "0.0.0.0"); err == nil {
		t.Fatal("accepted --tls-cert without --tls-key")
	}
}

func TestTLSConfigRejectsOldProtocols(t *testing.T) {
	cert, _, _, err := loadOrCreateCert("", "", t.TempDir(), "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if conf := tlsConfig(cert); conf.MinVersion != tls.VersionTLS12 {
		t.Fatalf("min version %x", conf.MinVersion)
	}
}

func TestParseCIDRs(t *testing.T) {
	prefixes, err := parseCIDRs("10.0.0.0/8, 192.168.1.20 ,fd00::/8")
	if err != nil {
		t.Fatal(err)
	}
	has := func(addr string) bool {
		a := netip.MustParseAddr(addr)
		for _, p := range prefixes {
			if p.Contains(a) {
				return true
			}
		}
		return false
	}
	for addr, want := range map[string]bool{"10.1.2.3": true, "192.168.1.20": true, "192.168.1.21": false, "127.0.0.1": true, "::1": true, "fd00::5": true, "8.8.8.8": false} {
		if has(addr) != want {
			t.Errorf("%s allowed=%v want %v", addr, !want, want)
		}
	}
	if p, _ := parseCIDRs(""); p != nil {
		t.Fatal("empty value must mean no allowlist")
	}
	if _, err := parseCIDRs("10.0.0.0/33"); err == nil {
		t.Fatal("accepted invalid CIDR")
	}
	if _, err := parseCIDRs("not-an-ip"); err == nil {
		t.Fatal("accepted invalid address")
	}
}
