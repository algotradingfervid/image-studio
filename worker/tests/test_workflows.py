"""Graph builders: node classes, valid wiring and parameter substitution.

Node input names and output arities are checked against a trimmed snapshot of
GET /object_info from ComfyUI v0.39.0 (tests/fixtures/object_info_v0.39.0.json).
"""

from __future__ import annotations

import pytest

from workflows import OUTPUT_TYPES, WorkflowError, build_workflow, sampler_node_ids

MODELS = ["chroma", "zimage", "flux2", "qwen"]

EXPECTED_CORE = {
    "chroma": {"UNETLoader", "CLIPLoader", "VAELoader", "ModelSamplingAuraFlow",
               "T5TokenizerOptions", "CLIPTextEncode", "CFGGuider", "KSamplerSelect",
               "BasicScheduler", "RandomNoise", "EmptySD3LatentImage",
               "SamplerCustomAdvanced", "VAEDecode", "SaveImage"},
    "zimage": {"UNETLoader", "CLIPLoader", "VAELoader", "ModelSamplingAuraFlow",
               "CLIPTextEncode", "ConditioningZeroOut", "EmptySD3LatentImage", "KSampler",
               "VAEDecode", "SaveImage"},
    "flux2": {"UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode", "ConditioningZeroOut",
              "CFGGuider", "KSamplerSelect", "Flux2Scheduler", "RandomNoise",
              "EmptyFlux2LatentImage", "SamplerCustomAdvanced", "VAEDecode", "SaveImage"},
    "qwen": {"UNETLoader", "CLIPLoader", "VAELoader", "QwenImage21Cache",
             "TextEncodeQwenImage21", "EmptyLatentImage", "KSampler", "VAEDecode", "SaveImage"},
}
CLIP_TYPES = {"chroma": "chroma", "zimage": "lumina2", "flux2": "flux2", "qwen": "qwen_image"}


def params(model, **kw):
    p = {"model": model, "prompt": "a red fox", "negativePrompt": "blurry",
         "width": 1216, "height": 832, "seed": 123456789, "steps": None, "cfg": None,
         "references": [], "loras": []}
    p.update(kw)
    return p


def by_class(graph, cls):
    return [(nid, n) for nid, n in graph.items() if n["class_type"] == cls]


def one(graph, cls):
    nodes = by_class(graph, cls)
    assert len(nodes) == 1, f"expected one {cls}, got {len(nodes)}"
    return nodes[0]


def _input_spec(object_info, cls, name):
    spec = object_info[cls]["input"]
    for section in ("required", "optional"):
        if name in spec.get(section, {}):
            return spec[section][name]
    if "." in name:  # Autogrow: "images.image_1"
        prefix, sub = name.split(".", 1)
        grow = spec.get("required", {}).get(prefix) or spec.get("optional", {}).get(prefix)
        if grow and grow["type"] == "COMFY_AUTOGROW_V3" and sub in grow["template"]["names"]:
            return {"type": next(iter(grow["template"]["input"]["required"].values()))[0]}
    return None


def assert_valid_graph(graph, out_id, object_info):
    assert out_id in graph and graph[out_id]["class_type"] == "SaveImage"
    for nid, node in graph.items():
        cls = node["class_type"]
        assert cls in object_info, f"{cls} not in ComfyUI v0.39.0"
        spec = object_info[cls]["input"]
        # every required (non-Autogrow) input is present
        for name, s in spec.get("required", {}).items():
            if s["type"] == "COMFY_AUTOGROW_V3":
                continue
            assert name in node["inputs"], f"node {nid} {cls} missing input {name}"
        for name, value in node["inputs"].items():
            s = _input_spec(object_info, cls, name)
            assert s is not None, f"node {nid} {cls} has unknown input {name!r}"
            if isinstance(value, list):  # link
                src, idx = value
                assert src in graph, f"node {nid}.{name} links to missing node {src}"
                outputs = object_info[graph[src]["class_type"]]["output"]
                assert 0 <= idx < len(outputs), f"node {nid}.{name} bad output index {idx}"
                assert outputs[idx] == s["type"], (
                    f"node {nid}.{name} expects {s['type']}, gets {outputs[idx]} from {src}")
            elif s["type"] == "COMBO" and "options" in s:
                assert value in s["options"], f"node {nid}.{name}={value!r} not an option"
        assert OUTPUT_TYPES[cls] == object_info[cls]["output"]
    # every node contributes to the output (ComfyUI only validates reachable nodes)
    reach, stack = set(), [out_id]
    while stack:
        n = stack.pop()
        if n in reach:
            continue
        reach.add(n)
        stack += [v[0] for v in graph[n]["inputs"].values() if isinstance(v, list)]
    assert reach == set(graph), f"unreachable nodes: {set(graph) - reach}"


@pytest.mark.parametrize("model", MODELS)
def test_t2i_graph_valid(model, registry, object_info):
    graph, out = build_workflow(params(model), registry)
    assert_valid_graph(graph, out, object_info)
    assert EXPECTED_CORE[model] <= {n["class_type"] for n in graph.values()}
    assert not by_class(graph, "LoadImage") and not by_class(graph, "LoraLoaderModelOnly")
    _, clip = one(graph, "CLIPLoader")
    assert clip["inputs"]["type"] == CLIP_TYPES[model]


@pytest.mark.parametrize("model", MODELS)
def test_registry_filenames_used(model, registry):
    m = next(x for x in registry["models"] if x["id"] == model)
    files = {f["folder"]: f["filename"] for f in m["files"]}
    graph, _ = build_workflow(params(model), registry)
    assert one(graph, "UNETLoader")[1]["inputs"]["unet_name"] == files["unet"]
    assert one(graph, "CLIPLoader")[1]["inputs"]["clip_name"] == files["clip"]
    assert one(graph, "VAELoader")[1]["inputs"]["vae_name"] == files["vae"]


@pytest.mark.parametrize("model", MODELS)
def test_params_applied(model, registry):
    graph, _ = build_workflow(params(model, seed=2**63 + 7, steps=13, cfg=2.5,
                                     width=896, height=1152), registry)
    seeds = [n["inputs"].get("seed", n["inputs"].get("noise_seed"))
             for n in graph.values() if n["class_type"] in ("KSampler", "RandomNoise")]
    assert seeds == [2**63 + 7]
    steps = [n["inputs"]["steps"] for n in graph.values()
             if n["class_type"] in ("KSampler", "BasicScheduler", "Flux2Scheduler")]
    assert steps == [13]
    cfgs = [n["inputs"]["cfg"] for n in graph.values() if n["class_type"] in ("KSampler", "CFGGuider")]
    assert cfgs == [2.5]
    latents = [n for n in graph.values() if n["class_type"].startswith("Empty")]
    assert len(latents) == 1
    assert (latents[0]["inputs"]["width"], latents[0]["inputs"]["height"]) == (896, 1152)
    if model == "flux2":
        sch = one(graph, "Flux2Scheduler")[1]["inputs"]
        assert (sch["width"], sch["height"]) == (896, 1152)


@pytest.mark.parametrize("model", MODELS)
def test_defaults_from_registry(model, registry):
    m = next(x for x in registry["models"] if x["id"] == model)
    d = m["defaults"]
    assert d["steps"] > 0 and d["sampler"] and d["scheduler"]
    graph, _ = build_workflow(params(model, negativePrompt=None), registry)
    steps = [n["inputs"]["steps"] for n in graph.values()
             if n["class_type"] in ("KSampler", "BasicScheduler", "Flux2Scheduler")]
    assert steps == [d["steps"]]
    cfgs = [n["inputs"]["cfg"] for n in graph.values() if n["class_type"] in ("KSampler", "CFGGuider")]
    assert cfgs == [d["cfg"]]
    samplers = [n["inputs"]["sampler_name"] for n in graph.values()
                if n["class_type"] in ("KSampler", "KSamplerSelect")]
    assert samplers == [d["sampler"]]


def test_prompts(registry):
    g, _ = build_workflow(params("chroma"), registry)
    texts = sorted(n["inputs"]["text"] for _, n in by_class(g, "CLIPTextEncode"))
    assert texts == ["a red fox", "blurry"]
    # chroma: registry default negative prompt when none is sent
    g, _ = build_workflow(params("chroma", negativePrompt=None), registry)
    neg = next(n for n in g.values() if n.get("_meta", {}).get("title") == "Negative")
    assert neg["inputs"]["text"].startswith("low quality")
    g, _ = build_workflow(params("qwen"), registry)
    enc = one(g, "TextEncodeQwenImage21")[1]["inputs"]
    assert (enc["prompt"], enc["negative_prompt"]) == ("a red fox", "blurry")


def test_template_constants(registry):
    g, _ = build_workflow(params("chroma"), registry)
    assert one(g, "ModelSamplingAuraFlow")[1]["inputs"]["shift"] == 1.0
    assert one(g, "BasicScheduler")[1]["inputs"]["scheduler"] == "beta"
    assert one(g, "T5TokenizerOptions")[1]["inputs"] == {
        "clip": [one(g, "CLIPLoader")[0], 0], "min_padding": 0, "min_length": 0}
    g, _ = build_workflow(params("zimage"), registry)
    assert one(g, "ModelSamplingAuraFlow")[1]["inputs"]["shift"] == 3.0
    ks = one(g, "KSampler")[1]["inputs"]
    assert (ks["sampler_name"], ks["scheduler"]) == ("res_multistep", "simple")
    neg = one(g, "ConditioningZeroOut")
    assert ks["negative"] == [neg[0], 0]
    g, _ = build_workflow(params("qwen"), registry)
    assert one(g, "QwenImage21Cache")[1]["inputs"]["device"] == "auto"
    ks = one(g, "KSampler")[1]["inputs"]
    enc = one(g, "TextEncodeQwenImage21")[0]
    assert ks["positive"] == [enc, 0] and ks["negative"] == [enc, 1]


@pytest.mark.parametrize("n", [1, 2, 4])
def test_flux2_references(n, registry, object_info):
    names = [f"ref{i}.png" for i in range(n)]
    g, out = build_workflow(params("flux2", references=names), registry)
    assert_valid_graph(g, out, object_info)
    loads = by_class(g, "LoadImage")
    assert [x[1]["inputs"]["image"] for x in loads] == names
    for _, sc in by_class(g, "ImageScaleToTotalPixels"):
        assert sc["inputs"]["megapixels"] == 1.0 and sc["inputs"]["upscale_method"] == "lanczos"
    refs = by_class(g, "ReferenceLatent")
    assert len(refs) == 2 * n  # positive and negative chains

    # Walk both chains back from the guider: each must apply every reference, in order.
    guider = one(g, "CFGGuider")[1]["inputs"]
    encodes = [nid for nid, _ in by_class(g, "VAEEncode")]
    for key, root_cls in (("positive", "CLIPTextEncode"), ("negative", "ConditioningZeroOut")):
        seen, cur = [], guider[key][0]
        while g[cur]["class_type"] == "ReferenceLatent":
            seen.append(g[cur]["inputs"]["latent"][0])
            cur = g[cur]["inputs"]["conditioning"][0]
        assert g[cur]["class_type"] == root_cls
        assert list(reversed(seen)) == encodes


@pytest.mark.parametrize("n", [1, 4])
def test_qwen_references(n, registry, object_info):
    names = [f"ref{i}.png" for i in range(n)]
    g, out = build_workflow(params("qwen", references=names), registry)
    assert_valid_graph(g, out, object_info)
    enc = one(g, "TextEncodeQwenImage21")[1]["inputs"]
    assert enc["vae"] == [one(g, "VAELoader")[0], 0]
    assert enc["resolution"] == 1024
    for i, name in enumerate(names, start=1):
        src = enc[f"images.image_{i}"][0]
        assert g[src] == {"class_type": "LoadImage", "inputs": {"image": name}}
    assert f"images.image_{n + 1}" not in enc


def test_qwen_t2i_has_no_vae_on_encoder(registry):
    g, _ = build_workflow(params("qwen"), registry)
    assert "vae" not in one(g, "TextEncodeQwenImage21")[1]["inputs"]


@pytest.mark.parametrize("model", MODELS)
def test_lora_chain(model, registry, object_info):
    loras = [{"filename": "a.safetensors", "strength": 0.8},
             {"filename": "b b.safetensors", "strength": 1.5},
             {"filename": "c.safetensors", "strength": 0.25}]
    g, out = build_workflow(params(model, loras=loras), registry)
    assert_valid_graph(g, out, object_info)
    chain = by_class(g, "LoraLoaderModelOnly")
    assert [n["inputs"]["lora_name"] for _, n in chain] == [
        f"{model}/a.safetensors", f"{model}/b b.safetensors", f"{model}/c.safetensors"]
    assert [n["inputs"]["strength_model"] for _, n in chain] == [0.8, 1.5, 0.25]
    unet = one(g, "UNETLoader")[0]
    assert chain[0][1]["inputs"]["model"] == [unet, 0]
    for (prev, _), (_, nxt) in zip(chain, chain[1:]):
        assert nxt["inputs"]["model"] == [prev, 0]
    # the last LoRA feeds whatever consumed the UNET before
    last = chain[-1][0]
    consumers = [n for n in g.values() if n["inputs"].get("model") == [last, 0]]
    assert len(consumers) >= 1
    assert not any(n["inputs"].get("model") == [unet, 0]
                   for n in g.values() if n["class_type"] != "LoraLoaderModelOnly")


def test_refs_and_loras_together(registry, object_info):
    g, out = build_workflow(params("flux2", references=["x.png", "y.png"],
                                   loras=[{"filename": "l.safetensors", "strength": 1}]), registry)
    assert_valid_graph(g, out, object_info)


def test_rejections(registry):
    with pytest.raises(WorkflowError, match="UNKNOWN_MODEL"):
        build_workflow(params("sdxl"), registry)
    with pytest.raises(WorkflowError, match="TOO_MANY_REFERENCES"):
        build_workflow(params("chroma", references=["a.png"]), registry)
    with pytest.raises(WorkflowError, match="TOO_MANY_REFERENCES"):
        build_workflow(params("flux2", references=[f"{i}.png" for i in range(5)]), registry)


def test_sampler_node_ids(registry):
    for model in MODELS:
        g, _ = build_workflow(params(model), registry)
        ids = sampler_node_ids(g)
        assert len(ids) == 1
        assert g[next(iter(ids))]["class_type"] in ("KSampler", "SamplerCustomAdvanced")


def test_pure(registry):
    p = params("flux2", references=["a.png"], loras=[{"filename": "l.safetensors", "strength": 1}])
    snapshot = repr(p)
    g1, o1 = build_workflow(p, registry)
    g2, o2 = build_workflow(p, registry)
    assert g1 == g2 and o1 == o2 and repr(p) == snapshot
