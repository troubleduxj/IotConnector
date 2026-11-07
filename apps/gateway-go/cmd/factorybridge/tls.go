package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 对外监听与 HTTPS（F2）。
//
// 规则（阶段 4 决定）：
//   - 监听回环地址时保持 HTTP，与之前行为一致。
//   - 监听非回环地址时强制 HTTPS；未提供证书则在数据目录 tls/ 下生成 ECDSA P-256 自签名证书。
//     自签名证书仅适合测试，生产应使用企业 CA 签发的证书（--tls-cert/--tls-key）。
//   - 可配置客户端网段白名单（--allow-cidr），不在名单内的来源直接 403。

// tlsConfig 返回 TLS 1.2+，1.2 只启用前向保密的 AEAD 套件。
func tlsConfig(cert tls.Certificate) *tls.Config {
	return &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{cert},
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384, tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305, tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
		},
	}
}

// loadOrCreateCert 优先读取指定证书；未指定时读取或生成 dataDir/tls 下的自签名证书。
// 返回值 selfSigned 用于在日志中提示。
func loadOrCreateCert(certFile, keyFile, dataDir, host string) (tls.Certificate, string, bool, error) {
	if certFile != "" || keyFile != "" {
		if certFile == "" || keyFile == "" {
			return tls.Certificate{}, "", false, fmt.Errorf("--tls-cert and --tls-key must be set together")
		}
		cert, err := tls.LoadX509KeyPair(certFile, keyFile)
		return cert, certFile, false, err
	}
	dir := filepath.Join(dataDir, "tls")
	certPath, keyPath := filepath.Join(dir, "selfsigned.crt"), filepath.Join(dir, "selfsigned.key")
	if cert, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
		if leaf, err := x509.ParseCertificate(cert.Certificate[0]); err == nil && time.Now().Before(leaf.NotAfter.Add(-30*24*time.Hour)) {
			return cert, certPath, true, nil
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return tls.Certificate{}, "", false, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, "", false, err
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "FactoryBridge gateway (self-signed)"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(825 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	if hostname, _ := os.Hostname(); hostname != "" {
		template.DNSNames = append(template.DNSNames, hostname)
	}
	// 绑定到具体 IP 时把它写进证书；绑定 0.0.0.0 时写入本机全部接口地址
	if ip := net.ParseIP(host); ip != nil && !ip.IsUnspecified() {
		template.IPAddresses = append(template.IPAddresses, ip)
	} else if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok && !ipnet.IP.IsLoopback() && !ipnet.IP.IsLinkLocalUnicast() {
				template.IPAddresses = append(template.IPAddresses, ipnet.IP)
			}
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, "", false, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, "", false, err
	}
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return tls.Certificate{}, "", false, err
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return tls.Certificate{}, "", false, err
	}
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	return cert, certPath, true, err
}

// parseCIDRs 解析逗号分隔的网段；单个地址按 /32 或 /128 处理。回环地址始终允许，
// 否则配置了白名单后本机运维（user 命令之外的 curl、健康检查）会被挡住。
func parseCIDRs(value string) ([]netip.Prefix, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	prefixes := []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128")}
	for _, part := range splitCSV(value) {
		if !strings.Contains(part, "/") {
			addr, err := netip.ParseAddr(part)
			if err != nil {
				return nil, fmt.Errorf("invalid address %q", part)
			}
			prefixes = append(prefixes, netip.PrefixFrom(addr, addr.BitLen()))
			continue
		}
		prefix, err := netip.ParsePrefix(part)
		if err != nil {
			return nil, fmt.Errorf("invalid CIDR %q", part)
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}
