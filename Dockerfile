# syntax=docker/dockerfile:1
# BuildKit is required for cache mounts (enabled automatically by build.js)
# Cache mounts persist PlatformIO packages across builds to avoid re-downloading

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONHTTPSVERIFY=1
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# Install system dependencies
RUN apt-get update && \
    apt-get install -y git curl python3 python3-pip python3-venv ca-certificates && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install PlatformIO (it installs its own Python in ~/.platformio/python)
RUN curl -fsSL https://raw.githubusercontent.com/platformio/platformio-core-installer/master/get-platformio.py -o get-platformio.py && \
    python3 get-platformio.py && \
    rm get-platformio.py

# Add PlatformIO to PATH
ENV PATH="/root/.platformio/penv/bin:$PATH"

# Update certifi in PlatformIO's Python environment to fix SSL issues
RUN /root/.platformio/penv/bin/pip install --upgrade certifi requests urllib3

# Build argument for Meshtastic version tag
ARG MESHTASTIC_VERSION

# Clone the Meshtastic firmware repository at the specified tag
RUN git clone --branch ${MESHTASTIC_VERSION} --depth 1 https://github.com/meshtastic/firmware.git /meshtastic

# Set working directory
WORKDIR /meshtastic

# Initialize submodules
RUN git submodule update --init

# Cache breaker - increment to invalidate cache from this point forward
ARG CACHE_BUST=1

# Cache cleanup - space-separated paths to delete from cache before install
# Example: --build-arg CACHE_CLEANUP="/root/.platformio/packages/framework-arduinoespressif32/.piopm /root/.platformio/packages/framework-arduinoespressif32"
ARG CACHE_CLEANUP=""

# Install PlatformIO project dependencies with cache mounts at standard locations
RUN --mount=type=cache,target=/root/.platformio/packages,id=pio-packages-shared,sharing=shared \
    --mount=type=cache,target=/root/.platformio/tools,id=pio-tools-shared,sharing=shared \
    --mount=type=cache,target=/root/.platformio/.cache,id=pio-cache-shared,sharing=shared \
    --mount=type=cache,target=/meshtastic/.pio,id=meshtastic-pio-shared,sharing=shared \
    # Clean up broken cache entries if specified
    if [ -n "$CACHE_CLEANUP" ]; then \
        echo "Cleaning up cache paths: $CACHE_CLEANUP"; \
        for path in $CACHE_CLEANUP; do \
            echo "Removing: $path"; \
            rm -rf "$path" 2>/dev/null || true; \
        done; \
    fi && \
    # Install packages (they'll be written to cache mounts)
    pio pkg install || \
    (echo "Retrying package install..." && sleep 10 && pio pkg install) || \
    (echo "Final retry..." && sleep 20 && pio pkg install)

# Copy from cache mounts (mounted at alternate locations) directly to final locations
# Single copy operation per directory - no intermediate steps or moves
RUN --mount=type=cache,target=/cache/packages,id=pio-packages-shared,sharing=shared \
    --mount=type=cache,target=/cache/tools,id=pio-tools-shared,sharing=shared \
    --mount=type=cache,target=/cache/pio-cache,id=pio-cache-shared,sharing=shared \
    --mount=type=cache,target=/cache/meshtastic-pio,id=meshtastic-pio-shared,sharing=shared \
    mkdir -p /root/.platformio /meshtastic && \
    cp -r /cache/packages /root/.platformio/packages && \
    cp -r /cache/tools /root/.platformio/tools && \
    cp -r /cache/pio-cache /root/.platformio/.cache && \
    cp -r /cache/meshtastic-pio /meshtastic/.pio 

# Add ls alias
RUN echo "alias ls='ls -lah'" >> /root/.bashrc

# RUN pio run