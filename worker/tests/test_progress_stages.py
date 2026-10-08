"""Fine-grained generate progress: stage mapping, stage lists and transitions.

The websocket sequences follow ComfyUI v0.39.0's event shapes (see
test_handler.py): execution_start, execution_cached {nodes}, executing
{node}, progress {value, max, node}, executed, execution_success.
"""

from __future__ import annotations

import pytest

import handler
from test_handler import env, gen_input  # noqa: F401  (env is a fixture)
from workflows import STAGE_PHASE, STAGES, build_workflow, graph_node_stages, graph_stages, node_stage

T2I_STAGES = ["loading_text_encoder", "encoding_prompt", "loading_model",
              "sampling", "decoding", "saving"]
REF_STAGES = ["loading_text_encoder", "encoding_prompt", "loading_model",
              "preparing_references", "sampling", "decoding", "saving"]


def params(model, **kw):
    p = {"model": model, "prompt": "a red fox", "negativePrompt": "blurry",
         "width": 1216, "height": 832, "seed": 1, "steps": None, "cfg": None,
         "references": [], "loras": []}
    p.update(kw)
    return p


# --------------------------------------------------------------------------- mapping
@pytest.mark.parametrize("cls,stage", [
    ("CLIPLoader", "loading_text_encoder"), ("DualCLIPLoader", "loading_text_encoder"),
    ("CLIPLoaderGGUF", "loading_text_encoder"),
    ("CLIPTextEncode", "encoding_prompt"), ("CLIPTextEncodeFlux", "encoding_prompt"),
    ("TextEncodeQwenImage21", "encoding_prompt"), ("T5TokenizerOptions", "encoding_prompt"),
    ("UNETLoader", "loading_model"), ("UnetLoaderGGUF", "loading_model"),
    ("LoraLoaderModelOnly", "loading_model"), ("ModelSamplingAuraFlow", "loading_model"),
    ("ModelSamplingFlux", "loading_model"),
    ("LoadImage", "preparing_references"), ("ImageScaleToTotalPixels", "preparing_references"),
    ("VAEEncode", "preparing_references"), ("ReferenceLatent", "preparing_references"),
    ("KSampler", "sampling"), ("SamplerCustomAdvanced", "sampling"),
    ("VAEDecode", "decoding"), ("SaveImage", "saving"),
    ("VAELoader", None), ("CFGGuider", None), ("EmptySD3LatentImage", None),
    ("RandomNoise", None), ("ConditioningZeroOut", None),
])
def test_node_stage(cls, stage):
    assert node_stage(cls) == stage


def test_every_stage_has_a_phase():
    assert set(STAGE_PHASE) == set(STAGES)
    assert {STAGE_PHASE[s] for s in STAGES} == {"loading", "sampling", "saving"}
    assert STAGE_PHASE["decoding"] == "saving"


@pytest.mark.parametrize("model", ["chroma", "zimage", "flux2", "qwen"])
def test_t2i_stage_list(model, registry):
    graph, _ = build_workflow(params(model), registry)
    assert graph_stages(graph) == T2I_STAGES
    ns = graph_node_stages(graph)
    for nid, node in graph.items():
        if node["class_type"] in ("KSampler", "SamplerCustomAdvanced"):
            assert ns[nid] == "sampling"
        if node["class_type"] in ("UNETLoader", "CLIPLoader"):
            assert ns[nid] in ("loading_model", "loading_text_encoder")


@pytest.mark.parametrize("model,refs", [("flux2", 2), ("qwen", 1)])
def test_reference_stage_only_with_references(model, refs, registry):
    with_refs, _ = build_workflow(params(model, references=[f"r{i}.png" for i in range(refs)]),
                                  registry)
    assert graph_stages(with_refs) == REF_STAGES
    without, _ = build_workflow(params(model), registry)
    assert "preparing_references" not in graph_stages(without)


def test_loras_map_to_loading_model(registry):
    graph, _ = build_workflow(params("flux2", loras=[{"filename": "a.safetensors", "strength": 1},
                                                     {"filename": "b.safetensors", "strength": 1}]),
                              registry)
    assert graph_stages(graph) == T2I_STAGES
    ns = graph_node_stages(graph)
    loras = [nid for nid, n in graph.items() if n["class_type"] == "LoraLoaderModelOnly"]
    assert len(loras) == 2 and all(ns[n] == "loading_model" for n in loras)


# --------------------------------------------------------------------------- generate
def _ids(graph, *classes):
    return [nid for nid, n in graph.items() if n["class_type"] in classes]


def realistic_script(fake, cached_classes=(), steps_tick=True):
    """Replaces FakeComfy._script with a full node-by-node execution sequence."""

    def script(graph):
        pid = fake.prompt_id
        cached = _ids(graph, *cached_classes)
        sampler = _ids(graph, "KSampler", "SamplerCustomAdvanced")[0]
        save = _ids(graph, "SaveImage")[0]
        order = (_ids(graph, "CLIPLoader") + _ids(graph, "T5TokenizerOptions")
                 + _ids(graph, "CLIPTextEncode", "TextEncodeQwenImage21")
                 + _ids(graph, "UNETLoader") + _ids(graph, "LoraLoaderModelOnly")
                 + _ids(graph, "ModelSamplingAuraFlow", "QwenImage21Cache")
                 + _ids(graph, "LoadImage", "ImageScaleToTotalPixels", "VAEEncode", "ReferenceLatent")
                 + _ids(graph, "VAELoader", "CFGGuider", "RandomNoise"))
        m = [{"type": "execution_start", "data": {"prompt_id": pid}},
             {"type": "execution_cached", "data": {"nodes": cached, "prompt_id": pid}}]
        for nid in order:
            if nid in cached:
                continue
            m.append({"type": "executing", "data": {"node": nid, "prompt_id": pid}})
            m.append("TICK")
        m.append({"type": "executing", "data": {"node": sampler, "prompt_id": pid}})
        for s in range(1, fake.steps + 1):
            m.append({"type": "progress", "data": {"value": s, "max": fake.steps,
                                                   "prompt_id": pid, "node": sampler}})
            if steps_tick:
                m.append("TICK")
        m += [{"type": "executing", "data": {"node": _ids(graph, "VAEDecode")[0], "prompt_id": pid}},
              "TICK",
              {"type": "executing", "data": {"node": save, "prompt_id": pid}},
              {"type": "executed", "data": {"node": save, "prompt_id": pid, "output": {"images": [
                  {"filename": "image_studio_00001_.png", "subfolder": "", "type": "output"}]}}},
              {"type": "executing", "data": {"node": None, "prompt_id": pid}}]
        fake.messages = m
        fake.history_body = {
            "outputs": {save: {"images": [{"filename": "image_studio_00001_.png",
                                           "subfolder": "", "type": "output"}]}},
            "status": {"status_str": "success", "completed": True, "messages": []}}

    fake._script = script


def transitions(sent):
    out = []
    for p in sent:
        if not out or out[-1] != p["stage"]:
            out.append(p["stage"])
    return out


def test_generate_stage_transitions_in_order(env):
    env.install("chroma")
    fake = env.fake(steps=6)
    realistic_script(fake)
    out = handler.handler(gen_input(model="chroma", steps=6))
    assert "error" not in out, out
    sent = env.sent
    assert transitions(sent) == T2I_STAGES
    for p in sent:
        assert set(p) == {"phase", "stage", "stages", "step", "totalSteps", "elapsedMs",
                          "stageElapsedMs", "cached", "cachedStages", "stageTimes"}
        assert p["stages"] == T2I_STAGES
        assert p["phase"] == STAGE_PHASE[p["stage"]]
        assert p["totalSteps"] == 6 and p["cached"] is False
    elapsed = [p["elapsedMs"] for p in sent]
    assert elapsed == sorted(elapsed)
    # every stage transition is sent at once, with the step count kept
    sampling = [p for p in sent if p["stage"] == "sampling"]
    assert sampling[0]["step"] == 0 and sampling[-1]["step"] == 6
    assert [p["step"] for p in sent if p["stage"] in ("decoding", "saving")] == [6] * len(
        [p for p in sent if p["stage"] in ("decoding", "saving")])
    last = sent[-1]
    assert last["stage"] == "saving" and last["phase"] == "saving"
    # finished stages carry their time; the text-encoder stretch saw 1 TICK (0.3 s)
    times = last["stageTimes"]
    assert list(times) == T2I_STAGES[:-1]
    assert times["loading_text_encoder"] >= 300
    assert times["sampling"] == 6 * 300
    assert times["decoding"] == 300


def test_generate_with_references_reports_reference_stage(env):
    env.install("flux2")
    fake = env.fake(steps=2)
    realistic_script(fake)
    import base64
    from test_handler import PNG_REF
    out = handler.handler(gen_input(references=[{"name": "a.png",
                                                 "base64": base64.b64encode(PNG_REF).decode()}],
                                    steps=2))
    assert "error" not in out, out
    assert env.sent[0]["stages"] == REF_STAGES  # known before anything ran
    assert transitions(env.sent) == REF_STAGES


def test_generate_cached_loaders(env):
    env.install("zimage")
    fake = env.fake(steps=3)
    realistic_script(fake, cached_classes=("CLIPLoader", "UNETLoader", "ModelSamplingAuraFlow"))
    out = handler.handler(gen_input(model="zimage", steps=3))
    assert "error" not in out, out
    after = [p for p in env.sent if p["cached"]]
    assert after, env.sent
    assert after[-1]["cachedStages"] == ["loading_text_encoder", "loading_model"]
    seen = transitions(env.sent)
    # the cached model stage never runs; text encoding still does
    assert "loading_model" not in seen
    assert seen[-4:] == ["encoding_prompt", "sampling", "decoding", "saving"]
    # partially cached stages are not reported as cached
    env.sent.clear()
    fake2 = env.fake(steps=3)
    realistic_script(fake2, cached_classes=("CLIPLoader",))
    out = handler.handler(gen_input(model="zimage", steps=3))
    assert "error" not in out, out
    assert env.sent[-1]["cachedStages"] == ["loading_text_encoder"]
    assert env.sent[-1]["cached"] is True
    assert "loading_model" in transitions(env.sent)


def test_step_updates_throttled_but_transitions_forced(env):
    env.install("chroma")
    fake = env.fake(steps=30)
    realistic_script(fake, steps_tick=False)  # all 30 steps at the same instant
    out = handler.handler(gen_input(model="chroma", steps=30))
    assert "error" not in out, out
    assert transitions(env.sent) == T2I_STAGES  # no transition was throttled away
    steps = [p["step"] for p in env.sent if p["stage"] == "sampling"]
    # entry (step 0) + the forced final step; intermediate steps fell within 0.5 s
    assert steps == [0, 30]
