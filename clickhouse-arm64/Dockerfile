# syntax=docker/dockerfile:1

# ClickHouse 25.3 LTS is built natively on the deployment host. The source
# revision and embedded archive are verified so source substitution or transfer
# damage cannot silently change the produced binary.
FROM debian:trixie-slim AS builder

ARG TARGETARCH
ARG CLICKHOUSE_SOURCE_REF=v25.3.14.14-lts
ARG CLICKHOUSE_SOURCE_COMMIT=84d6b30ad528e77d787ab7a2437406c1e2a5887a
ARG CLICKHOUSE_BUILD_JOBS=2

ENV CC=clang-19 \
    CXX=clang++-19

RUN test "${TARGETARCH}" = arm64 \
    || { echo "this image must be built with --platform=linux/arm64" >&2; exit 2; }

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        build-essential \
        ca-certificates \
        clang-19 \
        cmake \
        gawk \
        git \
        lld-19 \
        nasm \
        ninja-build \
        python3 \
        zstd \
        yasm \
    && rm -rf /var/lib/apt/lists/*

# The delivery ZIP contains the verified main repository and every recursive
# submodule. The target ARM64 host therefore does not contact GitHub at build
# time. The adjacent checksum also detects a damaged transfer/extraction.
COPY clickhouse-arm64/vendor/clickhouse-25.3.14.14-complete-source.tar.zst \
     clickhouse-arm64/vendor/clickhouse-25.3.14.14-complete-source.tar.zst.sha256 \
     /tmp/clickhouse-source/

RUN cd /tmp/clickhouse-source \
    && sha256sum --check clickhouse-25.3.14.14-complete-source.tar.zst.sha256 \
    && mkdir -p /src \
    && tar --zstd -xf clickhouse-25.3.14.14-complete-source.tar.zst -C /src \
    && test "$(cat /src/.clickhouse-source-revision)" = "${CLICKHOUSE_SOURCE_COMMIT}" \
    && sed -i 's|^ROOT_PATH=.*$|ROOT_PATH="/src"|' \
        /src/src/Storages/System/StorageSystemLicenses.sh \
        /src/utils/list-licenses/list-licenses.sh \
    && grep -qx 'ROOT_PATH="/src"' \
        /src/src/Storages/System/StorageSystemLicenses.sh \
    && grep -qx 'ROOT_PATH="/src"' \
        /src/utils/list-licenses/list-licenses.sh \
    && (cd /src/src/Storages/System \
        && ./StorageSystemLicenses.sh > /tmp/StorageSystemLicenses.generated.cpp) \
    && test -s /tmp/StorageSystemLicenses.generated.cpp \
    && rm -f /tmp/StorageSystemLicenses.generated.cpp \
    && rm -rf /tmp/clickhouse-source \
    && case "${CLICKHOUSE_BUILD_JOBS}" in \
        ''|*[!0-9]*|0) echo "CLICKHOUSE_BUILD_JOBS must be a positive integer" >&2; exit 2 ;; \
    esac

# NO_ARMV81_OR_HIGHER is ClickHouse's upstream maximum-compatibility AArch64
# profile. In 25.3 it selects -march=armv8+crc instead of the default
# ARMv8.2-A + LSE/RCpc profile. ARCH_NATIVE is explicitly disabled so the
# output does not accidentally inherit builder-host-only instructions.
# Persist Ninja objects across failed/repeated builds. A successful build is
# copied out of the cache mount so it becomes part of the builder image.
RUN --mount=type=cache,id=smpp-clickhouse-25.3.14.14-arm64-build,target=/src/build,sharing=locked \
    cmake -S /src -B /src/build -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER=clang-19 \
        -DCMAKE_CXX_COMPILER=clang++-19 \
        -DCMAKE_LINKER=/usr/bin/ld.lld-19 \
        -DARCH_NATIVE=OFF \
        -DNO_ARMV81_OR_HIGHER=ON \
        -DENABLE_RUST=OFF \
        -DENABLE_TESTS=OFF \
        -DENABLE_THINLTO=OFF \
        -DCOMPILER_CACHE=disabled \
        -DENABLE_CLICKHOUSE_ALL=OFF \
        -DENABLE_CLICKHOUSE_KEEPER=OFF \
        -DENABLE_CLICKHOUSE_KEEPER_CLIENT=OFF \
        -DENABLE_CLICKHOUSE_KEEPER_CONVERTER=OFF \
        -DENABLE_CLICKHOUSE_GIT_IMPORT=OFF \
    && cmake --build /src/build --target clickhouse-stripped --parallel "${CLICKHOUSE_BUILD_JOBS}" \
    && mkdir -p /out \
    && cp /src/build/programs/clickhouse-stripped /out/clickhouse \
    && /out/clickhouse --version

FROM debian:trixie-slim AS runtime

ARG TARGETARCH
ARG CLICKHOUSE_SOURCE_REF=v25.3.14.14-lts
ARG CLICKHOUSE_SOURCE_COMMIT=84d6b30ad528e77d787ab7a2437406c1e2a5887a

LABEL org.opencontainers.image.title="SMPP Telemetry ClickHouse ARM64 compatibility build" \
      org.opencontainers.image.source="https://github.com/ClickHouse/ClickHouse" \
      org.opencontainers.image.version="25.3.14.14" \
      org.opencontainers.image.revision="${CLICKHOUSE_SOURCE_COMMIT}" \
      io.smpp-telemetry.clickhouse.source-ref="${CLICKHOUSE_SOURCE_REF}" \
      io.smpp-telemetry.clickhouse.arm-profile="armv8+crc"

ARG DEBIAN_FRONTEND=noninteractive

RUN test "${TARGETARCH}" = arm64 \
    || { echo "this image must be built with --platform=linux/arm64" >&2; exit 2; } \
    && apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        gzip \
        locales \
        passwd \
        tzdata \
        wget \
    && groupadd --system --gid 101 clickhouse \
    && useradd --system --gid clickhouse --uid 101 \
        --home-dir /var/lib/clickhouse --shell /bin/bash clickhouse \
    && rm -rf /var/lib/apt/lists/* /var/cache/debconf /tmp/*

COPY --from=builder /out/clickhouse /tmp/clickhouse_binary/clickhouse

# Use ClickHouse's own installer and the entrypoint/config shipped by the same
# immutable source revision. This preserves CLICKHOUSE_PASSWORD_FILE and
# /docker-entrypoint-initdb.d semantics expected by compose.yaml.
RUN chmod 0755 /tmp/clickhouse_binary/clickhouse \
    && /tmp/clickhouse_binary/clickhouse install --user clickhouse --group clickhouse \
    && rm -rf /tmp/clickhouse_binary \
    && mkdir -p /docker-entrypoint-initdb.d /etc/clickhouse-client \
    && chmod ugo+Xrw -R \
        /var/lib/clickhouse \
        /var/log/clickhouse-server \
        /etc/clickhouse-server \
        /etc/clickhouse-client \
    && clickhouse local --query 'SELECT 1' >/dev/null

COPY --from=builder /src/docker/server/docker_related_config.xml /etc/clickhouse-server/config.d/docker_related_config.xml
COPY --from=builder /src/docker/server/entrypoint.sh /entrypoint.sh

RUN chmod 0755 /entrypoint.sh \
    && locale-gen en_US.UTF-8 \
    && clickhouse extract-from-config \
        --config-file /etc/clickhouse-server/config.xml \
        --key=path >/dev/null

ENV LANG=en_US.UTF-8 \
    TZ=UTC \
    CLICKHOUSE_CONFIG=/etc/clickhouse-server/config.xml

EXPOSE 9000 8123 9009
VOLUME /var/lib/clickhouse
ENTRYPOINT ["/entrypoint.sh"]
