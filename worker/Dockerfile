# syntax=docker/dockerfile:1
#
# Image Studio RunPod Serverless worker.
#
# Build from the REPO ROOT (the image needs shared/models.json):
#   docker buildx build --platform linux/amd64 -f worker/Dockerfile -t <image> .
#
# Base: runpod/worker-comfyui 5.10.0 "base-cuda12.8.1" (no baked-in models),
# pinned by its Docker Hub index digest. (5.11.0 is tagged on GitHub but was
# never published to Docker Hub.) Verified from the published image config
# (history + env), 2026-10-08:
#   - nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04 (CUDA 12.8.1, cuDNN 9.8.0)
#   - Python 3.12 venv at /opt/venv (on PATH); comfy-cli 1.13.0
#   - ComfyUI 0.34.0 as a git checkout at /comfyui
#   - torch 2.11.0 / torchvision 0.26.0 / torchaudio 2.11.0 from the cu128
#     index (Blackwell sm_120 / RTX 5090 capable; needs driver >= 570)
#   - CMD /start.sh: starts ComfyUI in the background (PID in
#     /tmp/comfyui.pid), then runs `python -u /handler.py`.
FROM runpod/worker-comfyui:5.10.0-base-cuda12.8.1@sha256:45a1abd8796dbbcbc631f3d7d0db942946ce2f82ff24a070e3e6c527eeff9c47

ARG COMFYUI_VERSION=v0.39.0

# 1. Upgrade ComfyUI in place. comfy-cli installs /comfyui with `git clone`
#    + `git checkout <tag>`, so switching versions is a tag checkout.
RUN cd /comfyui \
    && git fetch --force --tags origin \
    && git -c advice.detachedHead=false checkout --force "tags/${COMFYUI_VERSION}" \
    && git log -1 --format='ComfyUI %H %d'

# 2. Install the new version's requirements into the launch venv (/opt/venv —
#    NOT /comfyui/.venv, comfy-cli's workspace venv, which uv would otherwise
#    pick up from the working directory). The installed torch/torchvision/
#    torchaudio versions are frozen into a constraints file so v0.39.0's bare
#    `torch` requirement can never swap the cu128 builds for PyPI's CUDA 13
#    wheels (driver >= 580). Upstream's transformers/huggingface-hub ceiling
#    is kept. The final `python -c` asserts torch is still the +cu128 build.
RUN cd / \
    && uv pip freeze --python /opt/venv/bin/python \
         | grep -E '^(torch|torchvision|torchaudio)==' > /tmp/torch-constraints.txt \
    && cat /tmp/torch-constraints.txt \
    && uv pip install --python /opt/venv/bin/python -c /tmp/torch-constraints.txt \
         -r /comfyui/requirements.txt \
    && for r in /comfyui/custom_nodes/*/requirements.txt; do \
         [ -f "$r" ] && uv pip install --python /opt/venv/bin/python -c /tmp/torch-constraints.txt -r "$r" || true; \
       done \
    && uv pip install --python /opt/venv/bin/python -c /tmp/torch-constraints.txt \
         "transformers>=4.50.3,<5" "huggingface-hub<1.0" \
         "runpod>=1.7.12,<2" requests websocket-client \
    && python -c "import torch; v = torch.__version__; print('torch', v, 'cuda', torch.version.cuda); \
assert v.startswith('2.11.0') and v.endswith('+cu128'), v"

# 3. Fail the build if the version is wrong or ComfyUI can't import its nodes
#    (same CPU smoke test upstream uses).
RUN python -c "import sys; sys.path.insert(0, '/comfyui'); from comfyui_version import __version__ as v; \
assert 'v' + v == '${COMFYUI_VERSION}', v; print('ComfyUI', v)" \
    && cd /comfyui && timeout 300 python main.py --quick-test-for-ci --cpu

# 4. Model search paths on the network volume (replaces the upstream file).
COPY worker/src/extra_model_paths.yaml /comfyui/extra_model_paths.yaml

# 5. Our handler + modules + the shared registry.
COPY shared/models.json /image_studio/models.json
COPY worker/src/*.py /image_studio/
COPY worker/src/handler.py /handler.py
ENV PYTHONPATH=/image_studio \
    REGISTRY_PATH=/image_studio/models.json \
    VOLUME_ROOT=/runpod-volume \
    COMFYUI_PATH=/comfyui

RUN cd / && python -c "import handler, workflows, downloader; print('handler import ok')"

# /start.sh (from the base image) starts ComfyUI, then runs /handler.py.
CMD ["/start.sh"]
