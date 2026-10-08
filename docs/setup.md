# Image Studio — RunPod setup

This guide gets the worker image built and the RunPod Serverless endpoint running. It takes about 30–60 minutes, most of it waiting for the first image build.

What you end up with:
- the image `ghcr.io/algotradingfervid/image-studio-worker`, built by GitHub Actions
- a 100 GB RunPod network volume, `image-studio-models`, that holds the models
- a queue endpoint, `image-studio-worker`, set up as the spec says: RTX 5090, then L40S, then A6000; up to 2 workers, 0 minimum; 5 s idle timeout
- `RUNPOD_ENDPOINT_ID` filled in, in `.env`

Never commit `.env`. A pre-commit hook blocks any non-empty value in `.env.example`.

---

## 1. Accounts and keys (put them in `.env`)

| Key in `.env` | Where to get it |
|---|---|
| `RUNPOD_API_KEY` | RunPod console → **Settings → API Keys** → *Create API Key*. Give it **All**/read-write access, because the setup script creates resources. Add credit under **Billing**. |
| `HF_TOKEN` | First accept the FLUX.2 [klein] licence: open <https://huggingface.co/black-forest-labs/FLUX.2-klein-9b-fp8>, log in and click **Agree and access repository**. Then go to <https://huggingface.co/settings/tokens> → *Create new token* → type **Read**. |
| `CIVITAI_API_KEY` | <https://civitai.com/user/account> → **API Keys** → *Add API key*. |

Keep `.env` private: run `chmod 600 .env`. The scripts read the file at runtime and never print the values.

## 2. Build the worker image

### Option A (chosen): GitHub Actions → GHCR

The repo is public: <https://github.com/algotradingfervid/image-studio>. The workflow `.github/workflows/worker-image.yml` runs when you push to `main` and the push changes `worker/**` or `shared/**`. You can also run it from **Actions → worker-image → Run workflow**. It builds `linux/amd64` and pushes:

```
ghcr.io/algotradingfervid/image-studio-worker:latest
ghcr.io/algotradingfervid/image-studio-worker:sha-<commit sha>
```

You don't need any secrets. The workflow uses `GITHUB_TOKEN` with the `packages: write` permission. Layer caching uses the GitHub Actions cache (`type=gha`; the repo has 10 GB of cache).

**Disk space:** the `runpod/worker-comfyui` base image is about 14.7 GB compressed and more than 30 GB unpacked. A standard runner has only about 20–25 GB free. So the workflow first deletes the preinstalled SDKs, then moves Docker onto whichever of `/` or `/mnt` has more space. Each run logs `df -h` before and after the build. If a build ever fails with "no space left on device", check those numbers first.

**GHCR limits** ([docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)):
- Each layer can be at most 10 GB. The largest base layer is 6.7 GB.
- Each layer upload has a 10-minute timeout.

#### Make the package public (once, after the first successful build)

GHCR packages start out **private**, even when the repo is public. GitHub's docs say: *"When you first publish a package, the default visibility is private."* RunPod can only pull the image without credentials once the package is public.

1. Open <https://github.com/users/algotradingfervid/packages/container/image-studio-worker/settings>. You can also get there from the repo page: **Packages → image-studio-worker → Package settings**.
2. Under **Danger Zone**, click **Change visibility**, choose **Public**, type the package name and confirm.

GitHub warns: *"Once you make a package public, you cannot make it private again."*

Check that an anonymous pull works. GHCR hands out an anonymous token only when the package is public:
```bash
T=$(curl -s "https://ghcr.io/token?scope=repository:algotradingfervid/image-studio-worker:pull" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $T" \
  -H "Accept: application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json" \
  https://ghcr.io/v2/algotradingfervid/image-studio-worker/manifests/latest   # 200 = public; 401/403 = private or missing
```

#### Alternative: keep the package private and give RunPod registry credentials

1. Create a GitHub **classic** personal access token that has only the `read:packages` scope.
2. Add `GHCR_USERNAME=algotradingfervid` and `GHCR_TOKEN=<that PAT>` to `.env`.
3. Run `runpod_setup.py` with `--registry-auth`. It creates the RunPod registry credential `image-studio-ghcr` (`POST /v2/registries`) and sets it on the endpoint.

If you already have a RunPod registry credential for this GitHub account, pass `--registry-id <id>` instead. You can find its id in the console under **Settings → Container Registry Auth**.

### Option B: local Docker (Docker Desktop, OrbStack or colima)

Docker is not installed on this Mac. If you install it:
```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u algotradingfervid --password-stdin   # PAT with write:packages
WORKER_IMAGE=ghcr.io/algotradingfervid/image-studio-worker scripts/build_worker.sh
```
The script runs `docker buildx build --platform linux/amd64 -f worker/Dockerfile .` from the repo root and pushes `:latest` and `:<git sha>`. Things to know:
- On Apple Silicon the build runs under emulation, so it is slow.
- Give the Docker VM at least 80 GB of disk, for example `colima start --disk 100`.
- Use `--load` to build locally without pushing.

### Option C: RunPod builds from GitHub (no registry at all)

RunPod can also build the image itself:
1. In RunPod, open **Settings → Connections** and connect GitHub.
2. Go to **Serverless → New Endpoint → Import Git Repository** and pick the repo and branch.
3. Set **Dockerfile Path** to `worker/Dockerfile`.

Source: [docs](https://docs.runpod.io/serverless/workers/github-integration). Limits:
- The `docker build` step can take at most 30 minutes, and the whole build at most 160 minutes.
- The image can be at most 80 GB.
- The base image must be public. Ours is: `runpod/worker-comfyui`.
- A plain push does not redeploy. You have to **create a GitHub release** to trigger a new build.

**Not verified:** RunPod's docs don't say whether the build context is the repo root or the Dockerfile's folder. Our Dockerfile copies `shared/models.json` from the repo root, so this matters. If the build fails with a `COPY shared/...` error, the context is `worker/` and this option won't work without changes. This option also creates its own endpoint in the console, so set the GPUs, volume and env vars by hand, as in §6. Option A is the tested path.

## 3. Plan the RunPod resources (dry run, the default)

```bash
python3 scripts/runpod_setup.py                 # same as --dry-run; changes nothing
```

This prints:
- the GPU pools
- the data centers ranked by **current** serverless stock of RTX 5090, L40S and A6000; only data centers that offer standard network volumes are included
- every resource it would create, with secret values masked

Useful flags:

| Flag | Meaning |
|---|---|
| `--image ghcr.io/...:sha-<sha>` | Pin a specific build. The default is `$WORKER_IMAGE`, otherwise `ghcr.io/algotradingfervid/image-studio-worker:latest`. |
| `--datacenter EU-RO-1` | Choose the volume's data center yourself. The default `auto` picks the best-stocked data center at that moment. Once the volume exists, its data center is always used. |
| `--wide-gpus` | Also allow the other cards in the same pools: L40, RTX 6000 Ada, A40 and RTX PRO 6000 MIG 48 GB. Workers start more reliably. |
| `--plain-env` | Store `HF_TOKEN` and `CIVITAI_API_KEY` as plain env values instead of RunPod secrets. |
| `--rotate-secrets` | Push the current `.env` token values into the existing RunPod secrets. |
| `--registry-auth` / `--registry-id` | For a private image (see §2). |
| `--workers-max`, `--idle-timeout`, `--timeout-ms`, `--container-disk-gb`, `--volume-gb`, `--min-cuda`, `--no-flashboot` | Override the defaults: 2, 5 s, 600 000 ms, 20 GB, 100 GB, CUDA 12.8, FlashBoot on. |

**Choosing a data center.** A network volume locks the endpoint to the volume's data center. You can't move it later without deleting the volume and downloading the models again. On 2026-10-08:
- Most of the 5090 serverless stock that had volume support was in **EUR-NO-1** and **EU-RO-1**.
- L40S and A6000 serverless stock showed only in data centers without network volumes: US-MO-1, US-TX-4, EU-NL-1 and US-KS-2.

So in practice the workers run on RTX 5090. Use `--wide-gpus` for more 48 GB fallbacks, such as RTX 6000 Ada in US-IL-1 or RTX PRO 6000 MIG in US-NE-1. Run the dry run, look at the ranking, then pass `--datacenter` explicitly.

## 4. Create the resources

```bash
python3 scripts/runpod_setup.py --apply --datacenter EUR-NO-1   # or the one you chose
```

It creates the following, in this order:
1. The network volume `image-studio-models`: 100 GB, STANDARD tier.
2. The RunPod **secrets** `image-studio-hf-token` and `image-studio-civitai-key`, from `.env`. The endpoint env refers to them as `{{ RUNPOD_SECRET_image-studio-hf-token }}`, so the values never sit in the endpoint config.
3. The endpoint `image-studio-worker`.

It prints every id and writes `RUNPOD_ENDPOINT_ID` into `.env`. Every other line, comment and the file mode (600) are kept.

Running it again is safe. Resources are found by name, unchanged ones are skipped, and an existing endpoint is only PATCHed for fields that differ. For example, after a new image build:
```bash
python3 scripts/runpod_setup.py --apply --image ghcr.io/algotradingfervid/image-studio-worker:sha-<sha>
```

Check that the endpoint answers:
```bash
set -a; . ./.env; set +a
curl -s -H "Authorization: Bearer $RUNPOD_API_KEY" "https://api.runpod.ai/v2/$RUNPOD_ENDPOINT_ID/health"
```
Then open the app and go to **Settings → Test connection**, then **Models → Refresh**. The first job pays a cold start, because RunPod pulls the ~15 GB image onto the host.

## 5. Costs (estimates, 2026-10-08 list prices)

| Item | Price | Notes |
|---|---|---|
| Network volume, 100 GB standard | $0.07/GB/month → **≈ $7.00/month** | Billed whether you use it or not. Delete it to stop paying. |
| RTX 5090 worker (pool ADA_32_PRO) | $1.58/h ≈ **$0.00044/s** | Billed only while a worker runs, including the 5 s idle timeout. |
| L40S worker (pool ADA_48_PRO) | $1.75/h ≈ $0.00049/s | |
| A6000 worker (pool AMPERE_48) | $1.22/h ≈ $0.00034/s | |
| Image storage (GHCR, public package) | free | |

Prices come from `GET /v2/catalog/gpus` and the [network volume docs](https://docs.runpod.io/storage/network-volumes).

**Per image, warm worker on an RTX 5090.** These are guesses until the end-to-end run records real numbers in `docs/results.md`:

| Model | Time per image | Cost per image |
|---|---|---|
| Z-Image Turbo or FLUX.2 klein | about 3–8 s | ≈ $0.002–0.004 |
| Chroma, 40 steps | about 25–45 s | ≈ $0.011–0.02 |
| Qwen-Image | about 20–40 s | ≈ $0.009–0.018 |

**Cold starts** cost extra: booting the worker and loading 15–25 GB of model files from the volume takes about 30–120 s, which is about $0.01–0.05 each time.

**Model downloads** run on a GPU worker too: roughly 100 GB at 100–300 MB/s comes to about 6–17 minutes, or about $0.15–0.45 for all four models.

**Example month:** 300 images with 30 cold starts comes to about $7 for the volume plus $2–5 of compute.

## 6. Manual console fallback

If the script can't be used, do the same steps in <https://console.runpod.io>:

1. **Storage → New Network Volume**: name `image-studio-models`, 100 GB, a data center that lists RTX 5090 (for example EUR-NO-1 or EU-RO-1).
2. **Settings → Secrets → Create Secret**:
   - `image-studio-hf-token`, with your HF token as the value
   - `image-studio-civitai-key`, with your Civitai key as the value
3. **Serverless → New Endpoint → Import from Docker registry**: image `ghcr.io/algotradingfervid/image-studio-worker:latest`. Then:
   - **Endpoint type:** Queue.
   - **GPUs, in priority order:** 32 GB PRO (RTX 5090), 48 GB PRO (L40S), 48 GB (A6000).
   - **Workers:** Max 2, Active 0. **Idle timeout:** 5 s. **Execution timeout:** 600 s. **FlashBoot:** on.
   - **Container disk:** 20 GB.
   - **Advanced → Network volume:** `image-studio-models`. This also pins the data center.
   - **Advanced → CUDA:** 12.8 or newer.
   - **Environment variables:**
     - `HF_TOKEN` = `{{ RUNPOD_SECRET_image-studio-hf-token }}`
     - `CIVITAI_API_KEY` = `{{ RUNPOD_SECRET_image-studio-civitai-key }}`

     The key icon in the env editor fills these in for you.
   - **Private image only:** first add a registry credential under **Settings → Container Registry Auth** (username plus a PAT with `read:packages`), then select it here.
4. Copy the endpoint id into `.env` as `RUNPOD_ENDPOINT_ID=`.

## 7. Teardown

```bash
python3 scripts/runpod_teardown.py                          # dry run: lists image-studio-* resources
python3 scripts/runpod_teardown.py --apply                  # deletes endpoint, secrets, registry credential
python3 scripts/runpod_teardown.py --apply --include-volume # ...and the volume
```

Teardown only touches resources whose name starts with `image-studio-`. It also clears `RUNPOD_ENDPOINT_ID` in `.env`. Use `--keep-secrets` to keep the RunPod secrets.

**Deleting the network volume deletes every downloaded model and LoRA on it.** That is about 100 GB to download again, and it can't be undone. The script keeps the volume unless you pass `--include-volume`, and then asks you to type the volume's name, or to pass `--yes` when no terminal is attached. With the endpoint gone, the volume alone costs about $7/month.

## Reference: APIs used

- RunPod REST API **v2**, `https://api.runpod.io/v2` ([OpenAPI](https://api.runpod.io/v2/openapi.json), [reference](https://docs.runpod.io/api-reference-v2/overview)). v1 (`rest.runpod.io/v1`) is deprecated and is **retired on 2026-11-15** ([migration guide](https://docs.runpod.io/api-reference-v2/migrate-from-v1)), which is why these scripts use v2.
- Endpoints called:
  - `POST/GET/DELETE /v2/network-volumes`
  - `POST/GET/PATCH/DELETE /v2/serverless`
  - `POST/GET/PATCH/DELETE /v2/account/secrets`
  - `POST/GET/DELETE /v2/registries`
  - `GET/DELETE /v2/templates` (teardown only)
  - `GET /v2/catalog/gpus?include=AVAILABILITY&product=SERVERLESS`
  - `GET /v2/catalog/datacenters`
- In v2 an endpoint holds its own container settings (image, env, disk, registry). RunPod keeps a bound template internally and deletes it along with the endpoint, so the scripts don't create a separate template.
- Testing: `python3 -m unittest discover -s scripts/tests -v`
