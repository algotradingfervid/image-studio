"""Pure ComfyUI API-format graph builders for the four Image Studio models.

`build_workflow(params, registry) -> (graph, output_node_id)`

Each graph is a faithful API-format conversion of the official Comfy-Org
workflow template (https://github.com/Comfy-Org/workflow_templates, main @
8be1f8c4, checked 2026-10-08), with our filenames from shared/models.json and
the request parameters substituted. Prompt-enhancer branches, notes, preview
and compare nodes of the templates are left out (out of scope).

  chroma  templates/image_chroma_text_to_image.json
  zimage  templates/image_z_image_turbo.json
  flux2   templates/image_flux2_klein_text_to_image.json ("Flux.2 Klein 4B
          Distilled" subgraph; same wiring as 9B) and, with references,
          templates/image_flux2_klein_image_edit_9b_distilled.json
  qwen    templates/image_qwen_image_2_1_t2i.json and, with references,
          templates/image_qwen_image_2_1_image_edit.json

`params` (already validated by the handler):
  model, prompt, negativePrompt, width, height, seed, steps, cfg,
  references: [str]    ComfyUI input-image names (already uploaded)
  loras: [{filename, strength}]
  initImage: {name, width, height} | None   img2img start image (already
                       uploaded; width/height = its pixel size after EXIF
                       orientation), chroma and zimage only
  denoise: float       img2img strength (0.05-1.0, default 0.6)
Missing steps/cfg/negativePrompt fall back to the registry defaults.

img2img (models with "supportsImg2Img"): the empty latent is replaced by
  LoadImage -> ImageScaleToTotalPixels(lanczos, 1 MP) -> ImageScale(lanczos,
  W, H, center crop) -> VAEEncode(model VAE)
where (W, H) = init_image_size(width, height): 1 MP, both sides rounded to
multiples of 16. The requested width/height are ignored. The sampler's
denoise (KSampler.denoise for Z-Image, BasicScheduler.denoise for Chroma) is
set to `denoise`; steps stay as given (ComfyUI trims the schedule itself).

Every node id is a string; links are `[node_id, output_index]`.
"""

from __future__ import annotations

import math
from typing import Any

from registry import get_model, model_file

# Output indexes of the node classes we link from (verified against
# /object_info of ComfyUI v0.39.0).
OUTPUT_TYPES: dict[str, list[str]] = {
    "UNETLoader": ["MODEL"],
    "CLIPLoader": ["CLIP"],
    "VAELoader": ["VAE"],
    "LoraLoaderModelOnly": ["MODEL"],
    "CLIPTextEncode": ["CONDITIONING"],
    "T5TokenizerOptions": ["CLIP"],
    "ModelSamplingAuraFlow": ["MODEL"],
    "BasicScheduler": ["SIGMAS"],
    "CFGGuider": ["GUIDER"],
    "KSamplerSelect": ["SAMPLER"],
    "RandomNoise": ["NOISE"],
    "SamplerCustomAdvanced": ["LATENT", "LATENT"],
    "EmptySD3LatentImage": ["LATENT"],
    "EmptyLatentImage": ["LATENT"],
    "EmptyFlux2LatentImage": ["LATENT"],
    "Flux2Scheduler": ["SIGMAS"],
    "VAEDecode": ["IMAGE"],
    "VAEEncode": ["LATENT"],
    "SaveImage": ["IMAGE"],  # v0.39.0 SaveImage passes its images through
    "KSampler": ["LATENT"],
    "ConditioningZeroOut": ["CONDITIONING"],
    "ReferenceLatent": ["CONDITIONING"],
    "ImageScaleToTotalPixels": ["IMAGE"],
    "ImageScale": ["IMAGE"],
    "LoadImage": ["IMAGE", "MASK"],
    "TextEncodeQwenImage21": ["CONDITIONING", "CONDITIONING", "LATENT"],
    "QwenImage21Cache": ["MODEL"],
}

# Node classes whose ComfyUI "progress" events are the sampling steps.
SAMPLER_CLASSES = frozenset({"KSampler", "SamplerCustomAdvanced"})

FILENAME_PREFIX = "image_studio"

# Template constants (see module docstring for the source of each).
CHROMA_SHIFT = 1.0            # ModelSamplingAuraFlow "Flow Shift" = 1
ZIMAGE_SHIFT = 3.0            # ModelSamplingAuraFlow = 3
FLUX2_REF_MEGAPIXELS = 1.0    # ImageScaleToTotalPixels(lanczos, 1.0, 1)
QWEN_REF_RESOLUTION = 1024    # TextEncodeQwenImage21 resolution (node + official default)
INIT_MEGAPIXELS = 1.0         # img2img start image scaled to 1 MP (1024 * 1024 px)
INIT_SIZE_STEP = 16           # latent-friendly: both sides multiples of 16
INIT_MIN_SIDE, INIT_MAX_SIDE = 64, 4096
DEFAULT_DENOISE = 0.6
MIN_DENOISE, MAX_DENOISE = 0.05, 1.0


class WorkflowError(ValueError):
    pass


class _Graph:
    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self._next = 1

    def add(self, class_type: str, title: str | None = None, **inputs: Any) -> str:
        node_id = str(self._next)
        self._next += 1
        node: dict[str, Any] = {"class_type": class_type, "inputs": inputs}
        if title:
            node["_meta"] = {"title": title}
        self.nodes[node_id] = node
        return node_id


def _out(node_id: str, index: int = 0) -> list:
    return [node_id, index]


def _resolved(params: dict, model: dict) -> dict:
    d = model["defaults"]
    p = dict(params)
    if p.get("steps") in (None, 0):
        p["steps"] = d["steps"]
    if p.get("cfg") is None:
        p["cfg"] = d["cfg"]
    if p.get("negativePrompt") is None:
        p["negativePrompt"] = d.get("negativePrompt", "")
    p.setdefault("references", [])
    p.setdefault("loras", [])
    if p.get("initImage"):
        if p.get("denoise") is None:
            p["denoise"] = DEFAULT_DENOISE
        p["denoise"] = min(max(float(p["denoise"]), MIN_DENOISE), MAX_DENOISE)
    return p


def init_image_size(width: int, height: int) -> tuple[int, int]:
    """Output size of an img2img job for a start image of `width` x `height`.

    Same math as ImageScaleToTotalPixels (v0.39.0: scale_by = sqrt(MP * 1024^2
    / (w * h)), round(side * scale_by / step) * step) with step 16, clamped
    to [64, 4096].
    """
    if width <= 0 or height <= 0:
        raise WorkflowError("INVALID_INIT_IMAGE: the start image has no pixels")
    scale = math.sqrt(INIT_MEGAPIXELS * 1024 * 1024 / (width * height))

    def side(v: int) -> int:
        r = round(v * scale / INIT_SIZE_STEP) * INIT_SIZE_STEP
        return int(min(max(r, INIT_MIN_SIDE), INIT_MAX_SIDE))

    return side(width), side(height)


def _init_latent(g: _Graph, init: dict, vae: str) -> tuple[list, int, int]:
    """img2img: start image -> 1 MP -> multiple-of-16 size -> VAE latent."""
    w, h = init_image_size(int(init["width"]), int(init["height"]))
    img = g.add("LoadImage", "Start image", image=init["name"])
    total = g.add("ImageScaleToTotalPixels", image=_out(img), upscale_method="lanczos",
                  megapixels=INIT_MEGAPIXELS, resolution_steps=1)
    sized = g.add("ImageScale", image=_out(total), upscale_method="lanczos",
                  width=w, height=h, crop="center")
    enc = g.add("VAEEncode", "Start image latent", pixels=_out(sized), vae=_out(vae))
    return _out(enc), w, h


def _denoise(p: dict) -> float:
    return float(p["denoise"]) if p.get("initImage") else 1.0


def _ref_names(refs: list) -> list[str]:
    out = []
    for r in refs:
        out.append(r["name"] if isinstance(r, dict) else r)
    return out


def _loaders(g: _Graph, model: dict, clip_type: str) -> tuple[str, str, str]:
    unet = g.add("UNETLoader", unet_name=model_file(model, "unet")["filename"],
                 weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name=model_file(model, "clip")["filename"],
                 type=clip_type, device="default")
    vae = g.add("VAELoader", vae_name=model_file(model, "vae")["filename"])
    return unet, clip, vae


def _lora_chain(g: _Graph, model_id: str, model_out: list, loras: list) -> list:
    """One LoraLoaderModelOnly per LoRA, chained after the diffusion-model loader."""
    for lora in loras:
        node = g.add(
            "LoraLoaderModelOnly",
            model=model_out,
            lora_name=f"{model_id}/{lora['filename']}",
            strength_model=float(lora.get("strength", 1.0)),
        )
        model_out = _out(node)
    return model_out


def _decode_save(g: _Graph, latent: list, vae: str) -> str:
    dec = g.add("VAEDecode", samples=latent, vae=_out(vae))
    return g.add("SaveImage", images=_out(dec), filename_prefix=FILENAME_PREFIX)


# --------------------------------------------------------------------------
# Chroma1-HD — templates/image_chroma_text_to_image.json
# UNETLoader -> ModelSamplingAuraFlow(shift 1) -> BasicScheduler(beta) ;
# CLIPLoader(chroma) -> T5TokenizerOptions(0, 0) -> CLIPTextEncode x2 ;
# CFGGuider + RandomNoise + KSamplerSelect(euler) + EmptySD3LatentImage ->
# SamplerCustomAdvanced -> VAEDecode -> SaveImage
# --------------------------------------------------------------------------
def _chroma(p: dict, model: dict) -> tuple[dict, str]:
    d = model["defaults"]
    g = _Graph()
    unet, clip, vae = _loaders(g, model, "chroma")
    m = _lora_chain(g, model["id"], _out(unet), p["loras"])
    shift = g.add("ModelSamplingAuraFlow", model=m, shift=CHROMA_SHIFT)
    tok = g.add("T5TokenizerOptions", clip=_out(clip), min_padding=0, min_length=0)
    pos = g.add("CLIPTextEncode", "Positive", text=p["prompt"], clip=_out(tok))
    neg = g.add("CLIPTextEncode", "Negative", text=p["negativePrompt"], clip=_out(tok))
    guider = g.add("CFGGuider", model=_out(shift), positive=_out(pos),
                   negative=_out(neg), cfg=float(p["cfg"]))
    sampler = g.add("KSamplerSelect", sampler_name=d["sampler"] or "euler")
    sched = g.add("BasicScheduler", model=_out(shift), scheduler=d["scheduler"] or "beta",
                  steps=int(p["steps"]), denoise=_denoise(p))
    noise = g.add("RandomNoise", noise_seed=int(p["seed"]))
    if p.get("initImage"):
        latent, _, _ = _init_latent(g, p["initImage"], vae)
    else:
        latent = _out(g.add("EmptySD3LatentImage", width=int(p["width"]),
                            height=int(p["height"]), batch_size=1))
    sca = g.add("SamplerCustomAdvanced", noise=_out(noise), guider=_out(guider),
                sampler=_out(sampler), sigmas=_out(sched), latent_image=latent)
    return g.nodes, _decode_save(g, _out(sca, 0), vae)


# --------------------------------------------------------------------------
# Z-Image Turbo — templates/image_z_image_turbo.json
# UNETLoader -> ModelSamplingAuraFlow(shift 3) -> KSampler(res_multistep,
# simple, denoise 1); CLIPLoader(lumina2) -> CLIPTextEncode ->
# ConditioningZeroOut as negative; EmptySD3LatentImage.
# --------------------------------------------------------------------------
def _zimage(p: dict, model: dict) -> tuple[dict, str]:
    d = model["defaults"]
    g = _Graph()
    unet, clip, vae = _loaders(g, model, "lumina2")
    m = _lora_chain(g, model["id"], _out(unet), p["loras"])
    shift = g.add("ModelSamplingAuraFlow", model=m, shift=ZIMAGE_SHIFT)
    pos = g.add("CLIPTextEncode", "Positive", text=p["prompt"], clip=_out(clip))
    neg = g.add("ConditioningZeroOut", conditioning=_out(pos))
    if p.get("initImage"):
        latent, _, _ = _init_latent(g, p["initImage"], vae)
    else:
        latent = _out(g.add("EmptySD3LatentImage", width=int(p["width"]),
                            height=int(p["height"]), batch_size=1))
    ks = g.add("KSampler", model=_out(shift), seed=int(p["seed"]), steps=int(p["steps"]),
               cfg=float(p["cfg"]), sampler_name=d["sampler"] or "res_multistep",
               scheduler=d["scheduler"] or "simple", positive=_out(pos),
               negative=_out(neg), latent_image=latent, denoise=_denoise(p))
    return g.nodes, _decode_save(g, _out(ks), vae)


# --------------------------------------------------------------------------
# FLUX.2 [klein] 9B distilled
# t2i: templates/image_flux2_klein_text_to_image.json (distilled subgraph)
# refs: templates/image_flux2_klein_image_edit_9b_distilled.json — per image:
#   LoadImage -> ImageScaleToTotalPixels(lanczos, 1 MP, 1) -> VAEEncode ->
#   ReferenceLatent, chained on BOTH the positive conditioning and the
#   ConditioningZeroOut negative, in reference order.
# Output size: the template derives it from the first reference
# (GetImageSize); we use the requested width/height instead so the app's
# aspect-ratio choice is honoured.
# --------------------------------------------------------------------------
def _flux2(p: dict, model: dict) -> tuple[dict, str]:
    d = model["defaults"]
    g = _Graph()
    unet, clip, vae = _loaders(g, model, "flux2")
    m = _lora_chain(g, model["id"], _out(unet), p["loras"])
    pos_text = g.add("CLIPTextEncode", "Positive", text=p["prompt"], clip=_out(clip))
    neg_zero = g.add("ConditioningZeroOut", conditioning=_out(pos_text))
    pos, neg = _out(pos_text), _out(neg_zero)
    for name in _ref_names(p["references"]):
        img = g.add("LoadImage", image=name)
        scaled = g.add("ImageScaleToTotalPixels", image=_out(img), upscale_method="lanczos",
                       megapixels=FLUX2_REF_MEGAPIXELS, resolution_steps=1)
        enc = g.add("VAEEncode", pixels=_out(scaled), vae=_out(vae))
        pos = _out(g.add("ReferenceLatent", conditioning=pos, latent=_out(enc)))
        neg = _out(g.add("ReferenceLatent", conditioning=neg, latent=_out(enc)))
    guider = g.add("CFGGuider", model=m, positive=pos, negative=neg, cfg=float(p["cfg"]))
    sampler = g.add("KSamplerSelect", sampler_name=d["sampler"] or "euler")
    sched = g.add("Flux2Scheduler", steps=int(p["steps"]), width=int(p["width"]),
                  height=int(p["height"]))
    noise = g.add("RandomNoise", noise_seed=int(p["seed"]))
    latent = g.add("EmptyFlux2LatentImage", width=int(p["width"]), height=int(p["height"]),
                   batch_size=1)
    sca = g.add("SamplerCustomAdvanced", noise=_out(noise), guider=_out(guider),
                sampler=_out(sampler), sigmas=_out(sched), latent_image=_out(latent))
    return g.nodes, _decode_save(g, _out(sca, 0), vae)


# --------------------------------------------------------------------------
# Qwen-Image 2.1
# t2i: templates/image_qwen_image_2_1_t2i.json — UNETLoader ->
#   QwenImage21Cache(auto, default) -> KSampler(euler, simple);
#   CLIPLoader(qwen_image) -> TextEncodeQwenImage21(prompt, negative_prompt)
#   whose outputs 0/1 are positive/negative; EmptyLatentImage.
# refs: templates/image_qwen_image_2_1_image_edit.json — the same
#   TextEncodeQwenImage21 node gets the VAE and the reference images on its
#   Autogrow inputs "images.image_1".."images.image_N" (native edit/reference
#   conditioning). We take the template's custom_size=on path
#   (EmptyLatentImage at the requested size) rather than its latent output 2
#   (which follows image_1's size), so the requested aspect ratio is honoured.
# The template's prompt-enhancer branch (TextGenerate, off by default) is out
# of scope.
# --------------------------------------------------------------------------
def _qwen(p: dict, model: dict) -> tuple[dict, str]:
    d = model["defaults"]
    g = _Graph()
    unet, clip, vae = _loaders(g, model, "qwen_image")
    m = _lora_chain(g, model["id"], _out(unet), p["loras"])
    cache = g.add("QwenImage21Cache", model=m, device="auto", dtype="default")
    enc_inputs: dict[str, Any] = {
        "clip": _out(clip),
        "prompt": p["prompt"],
        "negative_prompt": p["negativePrompt"],
        "resolution": QWEN_REF_RESOLUTION,
    }
    refs = _ref_names(p["references"])
    if refs:
        enc_inputs["vae"] = _out(vae)
        for i, name in enumerate(refs, start=1):
            img = g.add("LoadImage", image=name)
            enc_inputs[f"images.image_{i}"] = _out(img)
    enc = g.add("TextEncodeQwenImage21", **enc_inputs)
    latent = g.add("EmptyLatentImage", width=int(p["width"]), height=int(p["height"]),
                   batch_size=1)
    ks = g.add("KSampler", model=_out(cache), seed=int(p["seed"]), steps=int(p["steps"]),
               cfg=float(p["cfg"]), sampler_name=d["sampler"] or "euler",
               scheduler=d["scheduler"] or "simple", positive=_out(enc, 0),
               negative=_out(enc, 1), latent_image=_out(latent), denoise=1.0)
    return g.nodes, _decode_save(g, _out(ks), vae)


_BUILDERS = {"chroma": _chroma, "zimage": _zimage, "flux2": _flux2, "qwen": _qwen}


def build_workflow(params: dict, registry: dict) -> tuple[dict, str]:
    model_id = params.get("model")
    if model_id not in _BUILDERS:
        raise WorkflowError(f"UNKNOWN_MODEL: {model_id!r}")
    model = get_model(registry, model_id)
    p = _resolved(params, model)
    refs = _ref_names(p["references"])
    if len(refs) > int(model.get("maxReferences", 0)):
        raise WorkflowError(
            f"TOO_MANY_REFERENCES: {model_id} accepts {model.get('maxReferences', 0)}")
    if p.get("initImage") and not model.get("supportsImg2Img", False):
        raise WorkflowError(f"IMG2IMG_NOT_SUPPORTED: {model_id} does not accept a start image")
    return _BUILDERS[model_id](p, model)


def sampler_node_ids(graph: dict) -> set[str]:
    return {nid for nid, n in graph.items() if n["class_type"] in SAMPLER_CLASSES}


# --------------------------------------------------------------------------
# Progress stages (handler progress payload "stage" / "stages")
# --------------------------------------------------------------------------
# Display order of the generation stages. ComfyUI's actual execution order
# depends on the graph, so consumers should mark stages done from the
# reported stage times rather than from their position in this list.
STAGES: tuple[str, ...] = (
    "loading_text_encoder",
    "encoding_prompt",
    "loading_model",
    "preparing_init_image",
    "preparing_references",
    "sampling",
    "decoding",
    "saving",
)

# Back-compat "phase" of each stage (the v1 progress protocol).
STAGE_PHASE: dict[str, str] = {
    "loading_text_encoder": "loading",
    "encoding_prompt": "loading",
    "loading_model": "loading",
    "preparing_init_image": "loading",
    "preparing_references": "loading",
    "sampling": "sampling",
    "decoding": "saving",
    "saving": "saving",
}

# Loader stages: when ComfyUI reports all their nodes as cached, the weights
# are already in memory and the stage costs nothing.
LOADER_STAGES = frozenset({"loading_text_encoder", "loading_model"})

_STAGE_OF_CLASS: dict[str, str] = {
    "CLIPLoader": "loading_text_encoder",
    "DualCLIPLoader": "loading_text_encoder",
    "CLIPLoaderGGUF": "loading_text_encoder",
    "TextEncodeQwenImage21": "encoding_prompt",
    "T5TokenizerOptions": "encoding_prompt",
    "UNETLoader": "loading_model",
    "UnetLoaderGGUF": "loading_model",
    "LoraLoaderModelOnly": "loading_model",
    "QwenImage21Cache": "loading_model",  # model patcher on the loader chain
    "LoadImage": "preparing_references",
    "ImageScaleToTotalPixels": "preparing_references",
    "ImageScale": "preparing_references",
    "VAEEncode": "preparing_references",
    "ReferenceLatent": "preparing_references",
    "KSampler": "sampling",
    "SamplerCustomAdvanced": "sampling",
    "VAEDecode": "decoding",
    "SaveImage": "saving",
}


def node_stage(class_type: str) -> str | None:
    """The progress stage a node of `class_type` belongs to; None = no change.

    Helper nodes (VAELoader, CFGGuider, schedulers, empty latents, ...) run in
    milliseconds and keep whatever stage is current.
    """
    stage = _STAGE_OF_CLASS.get(class_type)
    if stage is None:
        if class_type.startswith("CLIPTextEncode"):
            stage = "encoding_prompt"
        elif class_type.startswith("ModelSampling"):
            stage = "loading_model"
    return stage


# Image-preparation classes that, when they feed a sampler's latent_image,
# belong to the img2img start image rather than to the references.
_INIT_IMAGE_CLASSES = frozenset({"LoadImage", "ImageScaleToTotalPixels", "ImageScale",
                                 "VAEEncode"})


def init_image_node_ids(graph: dict) -> set[str]:
    """Nodes of the img2img start-image chain: every LoadImage / ImageScale* /
    VAEEncode upstream of a sampler's latent_image input."""
    out: set[str] = set()
    stack = []
    for node in graph.values():
        if node.get("class_type") in SAMPLER_CLASSES:
            link = node.get("inputs", {}).get("latent_image")
            if isinstance(link, list):
                stack.append(link[0])
    while stack:
        nid = stack.pop()
        node = graph.get(nid)
        if nid in out or node is None or node.get("class_type") not in _INIT_IMAGE_CLASSES:
            continue
        out.add(nid)
        stack += [v[0] for v in node.get("inputs", {}).values() if isinstance(v, list)]
    return out


def graph_node_stages(graph: dict) -> dict[str, str]:
    """{node_id: stage} for every node of `graph` that maps to a stage."""
    init_nodes = init_image_node_ids(graph)
    out = {}
    for nid, node in graph.items():
        stage = ("preparing_init_image" if nid in init_nodes
                 else node_stage(node.get("class_type", "")))
        if stage is not None:
            out[nid] = stage
    return out


def graph_stages(graph: dict) -> list[str]:
    """The stages that apply to `graph`, in display order (sampling always)."""
    present = set(graph_node_stages(graph).values()) | {"sampling"}
    return [s for s in STAGES if s in present]
