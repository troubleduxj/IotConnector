# 运行时镜像只装可执行文件与控制台；由 scripts/release.mjs 产出的 linux 包提供内容。
# 用法（仓库根目录）：
#   pnpm release linux/amd64
#   docker build -f deploy/docker/Dockerfile --build-arg PKG=dist/release/<版本>/factorybridge-<版本>-linux-amd64 -t factorybridge .
FROM gcr.io/distroless/static-debian12:nonroot
ARG PKG
COPY ${PKG}/factorybridge /opt/factorybridge/factorybridge
COPY ${PKG}/web /opt/factorybridge/web
VOLUME ["/data"]
EXPOSE 18080
USER nonroot:nonroot
ENTRYPOINT ["/opt/factorybridge/factorybridge"]
# 容器内监听 0.0.0.0 会触发 HTTPS（自签名证书写在 /data/tls）。compose 只把端口映射到宿主回环地址。
CMD ["run", "--data-dir", "/data", "--host", "0.0.0.0", "--port", "18080"]
