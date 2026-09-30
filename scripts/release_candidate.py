"""Candidate origin and acceptance checks for server publication.

GitHub run metadata, the approved workflow signer, and the downloaded artifact
digest are the source of truth. A manifest field is accepted only when it
matches those values. This module does not create acceptance results.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

RELEASE_CONTRACT = "server-candidate/1"
FINAL_PRODUCT_VERSION = "10.1.0"
APPROVED_CANDIDATE_CALLER = ".github/workflows/ci.yml"
APPROVED_CANDIDATE_SIGNER = ".github/workflows/server-candidate.yml"
APPROVED_PUBLISH_WORKFLOW = ".github/workflows/publish-stable.yml"
APPROVED_CALLER_PERMISSIONS = frozenset({"admin", "maintain"})
APPROVED_SECURITY = {
    "CodeQL": ".github/workflows/codeql.yml",
    "Secret scan": ".github/workflows/secret-scan.yml",
}
SECURITY_EVENTS = frozenset({"workflow_dispatch", "push", "schedule", "merge_group"})
SERVER_GATES = (
    "server",
    "server_ui",
    "server_migration",
    "server_backup",
    "server_network",
    "server_stability",
)
BATCH_GATES = (
    "vm_windows_pair",
    "vm_web_to_windows",
    "vm_android_x64",
    "network_direct_udp",
    "network_blocked_udp",
    "network_ipv6",
    "migration_9_to_10",
    "repeat_30",
    "input_release_2s",
    "network_restore_30s",
    "active_2h",
    "online_24h",
)
# Owner-approved waivers record a gate as deliberately not verified. A waiver is
# never a pass: it carries no measured result and is disclosed in release notes.
# "server" (the image/arch build gate) must always be a real pass.
SERVER_WAIVABLE = frozenset({
    "server_ui",
    "server_migration",
    "server_backup",
    "server_network",
    "server_stability",
})
BATCH_WAIVABLE = frozenset(BATCH_GATES)
WAIVED_STATUS = "accepted_with_waivers"
COMPONENTS = ("hub", "server", "client", "android")
REPOSITORIES = {
    "hub": "ZHanry/home-tunnel",
    "server": "ZHanry/home-tunnel-server",
    "client": "ZHanry/home-tunnel-client",
    "android": "ZHanry/home-tunnel-android",
}
UNRUN = {"", "not_run", "unrun", "pending", "skipped", "not_verified", "missing", "blocked", "untested"}
BANNED_TEXT = ("fixture", "synthetic", "placeholder")
ORIGINAL_SEAL = ("SHA256SUMS.txt", "SHA256SUMS.txt.sigstore.json")
MAX_ARTIFACT_BYTES = 200 * 1024 * 1024
MAX_EXTRACT_BYTES = 512 * 1024 * 1024
SHA40 = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
PLACEHOLDER_DIGESTS = {
    hashlib.sha256(b"").hexdigest(),
    hashlib.sha256(b"fixture").hexdigest(),
    hashlib.sha256(b"placeholder").hexdigest(),
    hashlib.sha256(b"test").hexdigest(),
}


def require(errors):
    if errors:
        raise SystemExit("; ".join(errors))


def canonical_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def evidence_digest(gate):
    body = {key: value for key, value in gate.items() if key != "evidence_sha256"}
    return hashlib.sha256(canonical_bytes(body)).hexdigest()


def validate_run_id(value):
    if not isinstance(value, str) or re.fullmatch(r"[1-9][0-9]{0,11}", value) is None:
        raise SystemExit("candidate run id is invalid")
    return value


def validate_repository(repository):
    if not isinstance(repository, str) or re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) is None:
        raise SystemExit("repository identity is invalid")
    return repository


def validate_branch(branch):
    if (
        not isinstance(branch, str)
        or re.fullmatch(r"[A-Za-z0-9._/-]{1,128}", branch) is None
        or branch.startswith(("/", "-", "."))
        or branch.endswith("/")
        or ".." in branch.split("/")
    ):
        raise SystemExit("branch ref is invalid")
    return branch


def validate_candidate_request(event, ref, sha, version):
    """Branch candidate gate. Main ancestry is intentionally not required."""
    if event != "workflow_dispatch":
        raise SystemExit("candidate builds are workflow_dispatch only and are not granted to pull_request")
    if not isinstance(ref, str) or not ref.startswith("refs/heads/") or "/pull/" in ref:
        raise SystemExit("candidate builds require a development branch ref")
    branch = validate_branch(ref.removeprefix("refs/heads/"))
    if SHA40.fullmatch(str(sha)) is None or len(set(str(sha))) == 1:
        raise SystemExit("candidate SHA is invalid")
    if not isinstance(version, str) or re.fullmatch(r"\d+\.\d+\.\d+", version) is None:
        raise SystemExit("candidate source version must stay the final stable version, not an rc")
    return branch


def candidate_signer_identity(repository, head_branch):
    validate_repository(repository)
    branch = validate_branch(head_branch)
    return f"https://github.com/{repository}/{APPROVED_CANDIDATE_SIGNER}@refs/heads/{branch}"


def publish_signer_identity(repository, ref):
    validate_repository(repository)
    if not isinstance(ref, str) or not ref.startswith("refs/heads/"):
        raise SystemExit("stable acceptance workflow identity is invalid")
    branch = validate_branch(ref.removeprefix("refs/heads/"))
    return f"https://github.com/{repository}/{APPROVED_PUBLISH_WORKFLOW}@refs/heads/{branch}"


def refuse_stable_server_rebuild(component, candidate):
    if component == "server" and candidate is None:
        raise SystemExit("Stable server tags do not build images. Publish the already accepted candidate bytes.")


def publication_tag(version):
    if version != FINAL_PRODUCT_VERSION:
        raise SystemExit("refusing to publish a non-final version")
    return "v" + version


def actor_login(run):
    actor = (run or {}).get("triggering_actor") or (run or {}).get("actor") or {}
    if not isinstance(actor, dict) or actor.get("type") == "Bot":
        raise SystemExit("workflow caller is not an approved user")
    login = str(actor.get("login", ""))
    if re.fullmatch(r"[A-Za-z0-9-]{1,39}", login) is None:
        raise SystemExit("workflow caller is not an approved user")
    return login


def trusted_sha(run, manifest):
    sha = str((run or {}).get("head_sha", ""))
    if SHA40.fullmatch(sha) is None or len(set(sha)) == 1:
        raise SystemExit("candidate run SHA is invalid")
    if str((manifest or {}).get("revision", "")) != sha:
        raise SystemExit("manifest SHA does not match the candidate run SHA")
    return sha


def artifact_digest(zip_bytes):
    if not isinstance(zip_bytes, (bytes, bytearray)) or not zip_bytes or len(zip_bytes) > MAX_ARTIFACT_BYTES:
        raise SystemExit("candidate artifact digest input is invalid")
    return "sha256:" + hashlib.sha256(zip_bytes).hexdigest()


def origin_errors(*, run, artifact, zip_bytes, manifest, signature_identity, repository, run_id, permission):
    errors = []
    if not isinstance(run_id, str) or re.fullmatch(r"[1-9][0-9]{0,11}", run_id) is None:
        errors.append("candidate run id is invalid")
    if not isinstance(run, dict):
        return errors + ["candidate run metadata is missing"]
    if str(run.get("id", "")) != str(run_id):
        errors.append("candidate run id does not match GitHub metadata")
    head_repository = run.get("head_repository") if isinstance(run.get("head_repository"), dict) else {}
    run_repository = run.get("repository") if isinstance(run.get("repository"), dict) else {}
    if (
        run_repository.get("full_name") != repository
        or head_repository.get("full_name") != repository
        or head_repository.get("fork") is True
    ):
        errors.append("candidate run repository is not this repository")
    if run.get("path") != APPROVED_CANDIDATE_CALLER or run.get("event") != "workflow_dispatch":
        errors.append("candidate run workflow is not the approved caller")
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        errors.append("candidate run workflow did not succeed")
    sha = str(run.get("head_sha", ""))
    if SHA40.fullmatch(sha) is None or len(set(sha)) == 1:
        errors.append("candidate run SHA is invalid")
    elif str((manifest or {}).get("revision", "")) != sha:
        errors.append("manifest SHA does not match the candidate run SHA")
    branch = str(run.get("head_branch") or "")
    branch_ok = True
    try:
        validate_branch(branch)
        validate_repository(repository)
    except SystemExit:
        branch_ok = False
        errors.append("candidate run branch ref is invalid")
    if branch_ok and signature_identity != candidate_signer_identity(repository, branch):
        errors.append("candidate signature identity does not match the approved signer")
    if (
        not isinstance(artifact, dict)
        or artifact.get("name") != "candidate-assets"
        or artifact.get("expired") is True
    ):
        errors.append("candidate artifact identity is missing")
    else:
        try:
            digest = artifact_digest(zip_bytes)
        except SystemExit:
            digest = ""
        if artifact.get("digest") != digest:
            errors.append("candidate artifact digest does not match the downloaded bytes")
        size = artifact.get("size_in_bytes")
        if type(size) is int and isinstance(zip_bytes, (bytes, bytearray)) and size != len(zip_bytes):
            errors.append("candidate artifact digest size does not match")
    if permission not in APPROVED_CALLER_PERMISSIONS:
        errors.append("workflow caller is not an approved maintainer")
    if not isinstance(manifest, dict):
        errors.append("candidate manifest is missing")
    else:
        if manifest.get("release_contract") != RELEASE_CONTRACT:
            errors.append("candidate release contract does not match")
        if str(manifest.get("run_id", "")) != str(run_id):
            errors.append("manifest run id does not match the candidate run")
        if manifest.get("caller_workflow") != APPROVED_CANDIDATE_CALLER or manifest.get("signer_workflow") != APPROVED_CANDIDATE_SIGNER:
            errors.append("manifest workflow does not match the approved caller")
        if manifest.get("repository") != repository:
            errors.append("manifest repository does not match the candidate run")
    return errors


def image_binding_errors(records, manifest, compose_text, sha, repository):
    errors = []
    images = manifest.get("images") if isinstance(manifest, dict) and isinstance(manifest.get("images"), dict) else {}
    if not isinstance(manifest, dict) or manifest.get("repository") != repository or manifest.get("revision") != sha:
        errors.append("candidate manifest is not bound to the run SHA")
    for name in ("control-center", "traffic-gateway"):
        record = records.get(name) if isinstance(records.get(name), dict) else {}
        pinned = images.get(name) if isinstance(images.get(name), dict) else {}
        digest = str(record.get("digest", ""))
        if record.get("revision") != sha or re.fullmatch(r"sha256:[a-f0-9]{64}", digest) is None:
            errors.append(f"candidate image digest is invalid for {name}")
            continue
        if pinned.get("digest") != digest or pinned.get("revision") != sha or pinned.get("image") != record.get("image"):
            errors.append(f"candidate image digest does not match the manifest for {name}")
        if f"{record.get('image')}@{digest}" not in str(compose_text):
            errors.append(f"deployment digest is not pinned for {name}")
    return errors


def security_gate_errors(runs, sha, repository):
    errors = []
    for name, path in APPROVED_SECURITY.items():
        found = False
        for run in runs or []:
            if not isinstance(run, dict) or run.get("name") != name or run.get("head_sha") != sha or run.get("path") != path:
                continue
            if run.get("conclusion") != "success" or run.get("event") not in SECURITY_EVENTS:
                continue
            head_repository = run.get("head_repository") if isinstance(run.get("head_repository"), dict) else {}
            if head_repository.get("full_name", repository) != repository or head_repository.get("fork") is True:
                continue
            found = True
            break
        if not found:
            errors.append(f"{name} has no successful same-repository run for this SHA")
    return errors


def parse_time(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def waiver_errors(name, waiver, now=None):
    """Validate an owner waiver record. A valid waiver is disclosure, not a pass."""
    if not isinstance(waiver, dict):
        return [f"{name} waiver is missing"]
    errors = []
    if waiver.get("approved_by") != "owner":
        errors.append(f"{name} waiver must be approved by the owner")
    approved = parse_time(waiver.get("approved_at"))
    current = now if now is not None else datetime.now(timezone.utc)
    if approved is None:
        errors.append(f"{name} waiver approval time is invalid")
    elif approved > current:
        errors.append(f"{name} waiver approval time is in the future")
    for field in ("reason", "disclosed_in"):
        value = waiver.get(field)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{name} waiver {field} is missing")
    return errors


def _waived_gate_errors(name, gate, waivable, now):
    """Checks for a gate recorded as waived instead of passed."""
    if name not in waivable:
        return [f"{name} cannot be waived"]
    errors = waiver_errors(name, gate.get("waiver"), now)
    if "measured_result" in gate or "observed_at" in gate or gate.get("result") == "passed":
        errors.append(f"{name} is waived and cannot carry a measured result")
    # write_acceptance_bundle still writes and seals the waiver record itself.
    if gate.get("evidence_path") != f"{name}.json":
        errors.append(f"{name} evidence path is invalid")
    if gate.get("evidence_sha256") != evidence_digest(gate) or bad_digest(gate.get("evidence_sha256")):
        errors.append(f"{name} evidence digest does not match")
    return errors


def _is_waived(record):
    return isinstance(record, dict) and record.get("status") == "waived"


def waived_items(acceptance):
    """Return (name, reason) for every waived server gate, batch gate and ui_coverage."""
    items = []
    if not isinstance(acceptance, dict):
        return items

    def reason_of(record):
        waiver = record.get("waiver") if isinstance(record.get("waiver"), dict) else {}
        reason = waiver.get("reason")
        return reason if isinstance(reason, str) else ""

    server_gates = acceptance.get("server_gates") if isinstance(acceptance.get("server_gates"), dict) else {}
    for name in SERVER_GATES:
        if _is_waived(server_gates.get(name)):
            items.append((name, reason_of(server_gates[name])))
    batch = acceptance.get("batch") if isinstance(acceptance.get("batch"), dict) else {}
    batch_gates = batch.get("gates") if isinstance(batch.get("gates"), dict) else {}
    for name in BATCH_GATES:
        if _is_waived(batch_gates.get(name)):
            items.append((name, reason_of(batch_gates[name])))
    if _is_waived(batch.get("ui_coverage")):
        items.append(("ui_coverage", reason_of(batch["ui_coverage"])))
    return items


def waiver_notes(acceptance):
    """Describe unverified coverage without rewriting its acceptance records."""
    items = waived_items(acceptance)
    if not items:
        return ""
    lines = ["## Not verified", ""]
    for name, _reason in items:
        lines.append(f"- `{name}`: not verified")
    return "\n".join(lines) + "\n"


def bad_digest(value):
    return (
        not isinstance(value, str)
        or SHA256.fullmatch(value) is None
        or len(set(value)) == 1
        or value in PLACEHOLDER_DIGESTS
    )


def batch_identity(batch):
    return {
        "product": batch.get("product"),
        "version": batch.get("version"),
        "source_frozen_at": batch.get("source_frozen_at"),
        "frp": batch.get("frp"),
        "sources": batch.get("sources"),
        "contract": batch.get("contract"),
    }


def batch_id_for(batch):
    return hashlib.sha256(canonical_bytes(batch_identity(batch))).hexdigest()


def _measured_ok(value):
    text = str(value or "").strip()
    lowered = text.lower()
    return bool(text) and not any(token in lowered for token in BANNED_TEXT)


def _common_gate_errors(name, gate, source_sha, frozen_at, waivable=frozenset(), now=None):
    if _is_waived(gate):
        return _waived_gate_errors(name, gate, waivable, now)
    if not isinstance(gate, dict) or gate.get("status") in UNRUN or gate.get("status") is None:
        return [f"{name} was not run"]
    if gate.get("status") == "stale":
        return [f"{name} is stale"]
    errors = []
    if gate.get("status") != "passed" or gate.get("result") != "passed":
        errors.append(f"{name} did not pass")
    if gate.get("source_sha") != source_sha:
        errors.append(f"{name} source SHA does not match this candidate")
    if not str(gate.get("environment", "")).strip() or not str(gate.get("command", "")).strip() or not _measured_ok(gate.get("measured_result")):
        errors.append(f"{name} is missing an environment, command, or measured result")
    if gate.get("evidence_path") != f"{name}.json":
        errors.append(f"{name} evidence path is invalid")
    if gate.get("evidence_sha256") != evidence_digest(gate) or bad_digest(gate.get("evidence_sha256")):
        errors.append(f"{name} evidence digest does not match")
    observed = parse_time(gate.get("observed_at"))
    if observed is None or (frozen_at is not None and observed < frozen_at):
        errors.append(f"{name} is stale")
    return errors


def _batch_errors(batch, source_sha, version, now=None):
    errors = []
    if not isinstance(batch, dict):
        return ["acceptance batch is missing"], None
    if batch.get("fixture") is True or batch.get("synthetic") is True:
        errors.append("fixture or synthetic records cannot be used as acceptance evidence")
    if batch.get("schema_version") != 1 or batch.get("product") != "Home Tunnel" or batch.get("stage") != "candidate":
        errors.append("acceptance batch identity is unsupported")
    if batch.get("version") != version or version != source_version_ok(version):
        errors.append("acceptance batch version does not match the sealed source version")
    if batch.get("frp") != "0.70.1":
        errors.append("acceptance batch FRP identity is unsupported")
    frozen_at = parse_time(batch.get("source_frozen_at"))
    if frozen_at is None:
        errors.append("acceptance batch source_frozen_at is invalid")
    if batch.get("batch_id") != batch_id_for(batch):
        errors.append("acceptance batch id does not match its source binding")
    sources = batch.get("sources") if isinstance(batch.get("sources"), dict) else {}
    if set(sources) != set(COMPONENTS):
        errors.append("acceptance batch is missing a component source")
    shas = []
    for name in COMPONENTS:
        source = sources.get(name) if isinstance(sources.get(name), dict) else {}
        sha = str(source.get("sha", ""))
        if source.get("repository") != REPOSITORIES[name] or SHA40.fullmatch(sha) is None or len(set(sha)) == 1:
            errors.append(f"{name} source SHA is missing or mismatched")
        else:
            shas.append(sha)
    if len(shas) == 4 and len(set(shas)) != 4:
        errors.append("the four source SHAs must be distinct commits")
    server = sources.get("server") if isinstance(sources.get("server"), dict) else {}
    if server.get("sha") != source_sha:
        errors.append("acceptance batch server SHA does not match this candidate")
    contract = batch.get("contract") if isinstance(batch.get("contract"), dict) else {}
    if contract.get("ref") != "api-v1.5.0" or contract.get("immutable") is not True:
        errors.append("immutable api-v1.5.0 contract identity is required")
    if SHA40.fullmatch(str(contract.get("revision", ""))) is None or bad_digest(contract.get("sha256")):
        errors.append("contract revision and digest are required")
    artifacts = {}
    declared = batch.get("artifacts") if isinstance(batch.get("artifacts"), dict) else {}
    if set(declared) != set(COMPONENTS):
        errors.append("acceptance batch artifacts are incomplete")
    for name in COMPONENTS:
        items = declared.get(name)
        if not isinstance(items, list) or not items:
            errors.append(f"{name} artifacts are missing")
            continue
        seen = set()
        for item in items:
            if not isinstance(item, dict):
                errors.append(f"{name} artifact is not an object")
                continue
            filename = str(item.get("filename", ""))
            if not filename or any(part in filename for part in ("/", "\\", "\n", "\r")) or filename in {".", ".."} or filename in seen:
                errors.append(f"{name} artifact name is unsafe or duplicated")
            seen.add(filename)
            if bad_digest(item.get("sha256")) or type(item.get("size_bytes")) is not int or item.get("size_bytes", 0) <= 0:
                errors.append(f"{name} artifact digest or size is missing")
            else:
                artifacts[(name, filename)] = item["sha256"]
    ui = batch.get("ui_coverage") if isinstance(batch.get("ui_coverage"), dict) else {}
    hub_sha = (sources.get("hub") or {}).get("sha") if isinstance(sources.get("hub"), dict) else None
    if _is_waived(ui):
        # A waived UI review has no reviewer, cases, or screenshot manifest to check.
        errors.extend(waiver_errors("ui_coverage", ui.get("waiver"), now))
        if hub_sha is None or ui.get("source_sha") != hub_sha:
            errors.append("UI coverage is not bound to the hub source")
    else:
        if ui.get("status") != "passed" or ui.get("reviewer") != "gemini" or ui.get("blocking_findings") != 0:
            errors.append("full UI coverage requires a passed Gemini review and zero blocking findings")
        applicable = ui.get("applicable_cases")
        cases = ui.get("cases")
        if type(applicable) is not int or applicable <= 0 or ui.get("reviewed_cases") != applicable or not isinstance(cases, list) or len(cases) != applicable:
            errors.append("UI coverage is incomplete")
        elif isinstance(cases, list):
            seen_cases = set()
            for case in cases:
                if (
                    not isinstance(case, dict)
                    or not str(case.get("id", "")).strip()
                    or case.get("result") != "passed"
                    or case.get("id") in seen_cases
                    or bad_digest(case.get("screenshot_sha256"))
                ):
                    errors.append("every applicable UI case must pass with its own screenshot digest")
                    break
                seen_cases.add(case["id"])
        if ui.get("source_sha") != hub_sha or bad_digest(ui.get("screenshot_manifest_sha256")):
            errors.append("UI coverage is not bound to the hub source and a manifest digest")
    gates = batch.get("gates") if isinstance(batch.get("gates"), dict) else {}
    missing = [name for name in BATCH_GATES if name not in gates]
    extra = [name for name in gates if name not in BATCH_GATES]
    if missing:
        errors.append("required batch gates are missing: " + ", ".join(missing))
    if extra:
        errors.append("unknown batch gates are present: " + ", ".join(extra))
    for name in BATCH_GATES:
        gate = gates.get(name)
        gate_errors = _common_gate_errors(
            name, gate, (gate or {}).get("source_sha") if isinstance(gate, dict) else None, frozen_at, BATCH_WAIVABLE, now
        )
        # Batch gates bind to their own component SHA, then the common helper checks that claim.
        # A waived gate has no measured artifact or metric, so only the waiver checks apply.
        if isinstance(gate, dict) and not _is_waived(gate):
            component = gate.get("source_component")
            component_sha = (sources.get(component) or {}).get("sha") if isinstance(sources.get(component), dict) else None
            if component not in COMPONENTS or gate.get("source_sha") != component_sha:
                gate_errors.append(f"{name} source SHA is mismatched or stale")
            filename = gate.get("artifact_filename")
            digest = gate.get("artifact_sha256")
            if artifacts.get((component, filename)) != digest or bad_digest(digest):
                gate_errors.append(f"{name} artifact digest is mismatched")
            if name == "repeat_30" and (gate.get("successes") != 30 or gate.get("attempts") != 30):
                gate_errors.append("repeat_30 requires 30 successes in 30 attempts")
            if name == "active_2h" and (type(gate.get("duration_seconds")) is not int or gate.get("duration_seconds", 0) < 7200):
                gate_errors.append("active_2h duration was not met")
            if name == "online_24h" and (type(gate.get("duration_seconds")) is not int or gate.get("duration_seconds", 0) < 86400):
                gate_errors.append("online_24h duration was not met")
            if name == "input_release_2s" and (type(gate.get("release_ms")) is not int or not 0 <= gate.get("release_ms", -1) <= 2000):
                gate_errors.append("input_release_2s was not measured within 2 seconds")
            if name == "network_restore_30s" and (type(gate.get("restore_seconds")) is not int or not 0 <= gate.get("restore_seconds", -1) <= 30):
                gate_errors.append("network_restore_30s was not measured within 30 seconds")
            if name == "network_blocked_udp" and gate.get("payload_fallback") is not False:
                gate_errors.append("blocked UDP must fail closed with no payload fallback")
            if name == "network_ipv6" and gate.get("address_family") != "ipv6":
                gate_errors.append("network_ipv6 must record an IPv6 path")
            if name == "migration_9_to_10" and (gate.get("from_version") != "9.0.0" or gate.get("to_version") != version):
                gate_errors.append("migration gate must bind 9.0.0 to the sealed source version")
        errors.extend(gate_errors)
    return errors, frozen_at


def source_version_ok(version):
    if isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+", version):
        return version
    return None


def _server_gate_errors(gates, source_sha, version, images, frozen_at, now=None):
    errors = []
    if not isinstance(gates, dict):
        return ["required server gates are missing: " + ", ".join(SERVER_GATES)]
    missing = [name for name in SERVER_GATES if name not in gates]
    extra = [name for name in gates if name not in SERVER_GATES]
    if missing:
        errors.append("required server gates are missing: " + ", ".join(missing))
    if extra:
        errors.append("unknown server gates are present: " + ", ".join(extra))
    parsed = {}
    waived = set()
    for name in SERVER_GATES:
        gate = gates.get(name)
        parsed[name] = gate if isinstance(gate, dict) else {}
        if _is_waived(gate):
            waived.add(name)
        errors.extend(_common_gate_errors(name, gate, source_sha, frozen_at, SERVER_WAIVABLE, now))
    # "server" is never waivable; its image/arch checks always apply.
    server = parsed["server"]
    if server.get("arches") != ["amd64", "arm64"]:
        errors.append("server evidence must include amd64 and arm64")
    claimed = server.get("images") if isinstance(server.get("images"), dict) else {}
    for name, record in images.items():
        if (claimed.get(name) or {}).get("digest") != record.get("digest"):
            errors.append(f"server gate digest does not match {name}")
    migration = parsed["server_migration"]
    backup = parsed["server_backup"]
    if "server_migration" not in waived:
        if migration.get("from_version") != "9.0.0" or migration.get("to_version") != version:
            errors.append("server_migration must bind 9.0.0 to this source version")
    if not {"server_migration", "server_backup"} & waived:
        if bad_digest(migration.get("backup_sha256")) or migration.get("backup_sha256") != backup.get("backup_sha256"):
            errors.append("server_migration backup digest does not match server_backup")
    if "server_backup" not in waived and backup.get("restore_verified") is not True:
        errors.append("server_backup did not verify restore")
    network = parsed["server_network"]
    if "server_network" not in waived:
        if network.get("direct_udp") != "passed" or network.get("payload_fallback") is not False or network.get("ipv6") != "passed":
            errors.append("server_network did not pass direct, blocked-UDP, and IPv6 checks")
    stability = parsed["server_stability"]
    if "server_stability" not in waived:
        if type(stability.get("active_duration_seconds")) is not int or stability.get("active_duration_seconds", 0) < 7200:
            errors.append("server_stability duration was not met")
        if type(stability.get("online_duration_seconds")) is not int or stability.get("online_duration_seconds", 0) < 86400:
            errors.append("server_stability duration was not met")
        if stability.get("successes") != 30 or stability.get("attempts") != 30:
            errors.append("server_stability requires 30 successes in 30 attempts")
        if type(stability.get("release_ms")) is not int or not 0 <= stability.get("release_ms", -1) <= 2000:
            errors.append("server_stability input release was not measured within 2 seconds")
        if type(stability.get("restore_seconds")) is not int or not 0 <= stability.get("restore_seconds", -1) <= 30:
            errors.append("server_stability network restore was not measured within 30 seconds")
    ui = parsed["server_ui"]
    if "server_ui" not in waived:
        if ui.get("reviewer") != "gemini" or ui.get("blocking_findings") != 0:
            errors.append("server_ui coverage is incomplete")
        applicable = ui.get("applicable_cases")
        cases = ui.get("cases")
        if type(applicable) is not int or applicable <= 0 or ui.get("reviewed_cases") != applicable or not isinstance(cases, list) or len(cases) != applicable:
            errors.append("server_ui coverage is incomplete")
        elif isinstance(cases, list):
            seen = set()
            for case in cases:
                if (
                    not isinstance(case, dict)
                    or not str(case.get("id", "")).strip()
                    or case.get("result") != "passed"
                    or case.get("id") in seen
                    or bad_digest(case.get("screenshot_sha256"))
                ):
                    errors.append("server_ui coverage is incomplete")
                    break
                seen.add(case["id"])
    return errors


def acceptance_errors(acceptance, *, source_sha, version, repository, images, deployment_hashes, run_id, now=None):
    if not isinstance(acceptance, dict):
        return ["acceptance record is missing"]
    errors = []
    if acceptance.get("fixture") is True or acceptance.get("synthetic") is True:
        errors.append("fixture or synthetic records cannot be used as acceptance evidence")
    if acceptance.get("schema") != "home-tunnel-server-acceptance/1" or acceptance.get("schema_version") != 1:
        errors.append("acceptance schema is unsupported")
    if acceptance.get("component") != "server" or acceptance.get("product") != "Home Tunnel":
        errors.append("acceptance identity is not the server component")
    if acceptance.get("version") != version or source_version_ok(version) is None:
        errors.append("acceptance version does not match the sealed source version")
    if acceptance.get("source_sha") != source_sha:
        errors.append("acceptance source SHA does not match this candidate")
    if acceptance.get("repository") != repository:
        errors.append("acceptance repository does not match this repository")
    claim = acceptance.get("candidate_run") if isinstance(acceptance.get("candidate_run"), dict) else {}
    if (
        str(claim.get("id", "")) != str(run_id)
        or claim.get("workflow") != APPROVED_CANDIDATE_CALLER
        or claim.get("signer_workflow") != APPROVED_CANDIDATE_SIGNER
        or claim.get("head_sha") != source_sha
        or claim.get("repository") != repository
        or claim.get("event") != "workflow_dispatch"
    ):
        errors.append("acceptance run binding does not match the candidate run")
    # A waived gate is disclosed, not passed, so the summary must say so.
    expected_status = WAIVED_STATUS if waived_items(acceptance) else "passed"
    if acceptance.get("status") != expected_status:
        if expected_status == WAIVED_STATUS:
            errors.append(f"acceptance status must be {WAIVED_STATUS} when a gate is waived")
        elif acceptance.get("status") == WAIVED_STATUS:
            errors.append(f"acceptance status {WAIVED_STATUS} requires at least one waived gate")
        else:
            errors.append("acceptance status is not passed")
    claimed_images = acceptance.get("images") if isinstance(acceptance.get("images"), dict) else {}
    for name, record in images.items():
        got = claimed_images.get(name) if isinstance(claimed_images.get(name), dict) else {}
        if got.get("digest") != record.get("digest") or got.get("image") != record.get("image") or got.get("revision") != source_sha:
            errors.append(f"acceptance digest does not match candidate image {name}")
    claimed_files = acceptance.get("deployment_sha256") if isinstance(acceptance.get("deployment_sha256"), dict) else {}
    for name, digest in deployment_hashes.items():
        if claimed_files.get(name) != digest or bad_digest(digest):
            errors.append(f"acceptance deployment hash mismatch: {name}")
    batch_problems, frozen_at = _batch_errors(acceptance.get("batch"), source_sha, version, now)
    errors.extend(batch_problems)
    errors.extend(_server_gate_errors(acceptance.get("server_gates"), source_sha, version, images, frozen_at, now))
    if acceptance.get("status") in ("passed", WAIVED_STATUS) and any("was not run" in item or "did not pass" in item or "missing" in item for item in errors):
        errors.append("summary status cannot replace gate records")
    return errors


def artifact_filename(name):
    if (not isinstance(name, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", name) is None
            or name.endswith(".") or re.fullmatch(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", name, re.I)):
        raise SystemExit("artifact path is invalid")
    return name


def safe_extract(zip_bytes, directory):
    import io
    import shutil
    import stat
    import zipfile

    directory = Path(directory)
    if directory.exists() or directory.is_symlink():
        raise SystemExit("candidate extraction requires a new directory")
    if len(zip_bytes) > MAX_ARTIFACT_BYTES:
        raise SystemExit("candidate archive exceeds the size limit")
    try:
        bundle = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as exc:
        raise SystemExit("candidate artifact is not a zip archive") from exc
    with bundle:
        members = bundle.infolist()
        names = [artifact_filename(info.filename) for info in members]
        if not 1 <= len(members) <= 256 or len({name.casefold() for name in names}) != len(names):
            raise SystemExit("candidate artifact has empty, excessive or duplicate entries")
        if sum(info.file_size for info in members) > MAX_EXTRACT_BYTES:
            raise SystemExit("candidate extracted files exceed the size limit")
        # Validate the entire archive before creating any output. GitHub
        # candidate-assets is deliberately a flat collection of regular files.
        for info in members:
            if info.orig_filename != info.filename:
                raise SystemExit("artifact path is invalid")
            if (info.is_dir() or info.flag_bits & 1 or info.file_size > MAX_ARTIFACT_BYTES
                    or stat.S_IFMT(info.external_attr >> 16) not in (0, stat.S_IFREG)
                    or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)):
                raise SystemExit("candidate artifact contains a linked, unsupported or oversized entry")
        directory.mkdir(parents=True)
        for info in members:
            with bundle.open(info) as source, (directory / info.filename).open("xb") as target:
                shutil.copyfileobj(source, target, 1024 * 1024)


def verify_artifact_files(directory):
    """Bind every candidate file to the separately verified original checksum seal."""
    directory = Path(directory)
    actual = set()
    for path in directory.iterdir():
        if path.is_symlink() or not path.is_file():
            raise SystemExit("candidate contains an unsealed or linked entry")
        actual.add(artifact_filename(path.name))
    listed, folded = {}, set()
    for line in (directory / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if match is None:
            raise SystemExit("candidate checksum manifest is invalid")
        checksum, name = match.groups()
        artifact_filename(name)
        if name in ORIGINAL_SEAL or name.casefold() in folded:
            raise SystemExit("candidate checksum manifest contains a duplicate or seal entry")
        folded.add(name.casefold())
        listed[name] = checksum
    if not listed or actual != set(listed) | set(ORIGINAL_SEAL):
        raise SystemExit("candidate has unsealed or missing files")
    for name, expected in listed.items():
        with (directory / name).open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                raise SystemExit(f"candidate checksum mismatch: {name}")
    return listed


def seal_snapshot(directory):
    directory = Path(directory)
    snapshot = {}
    for name in ORIGINAL_SEAL:
        path = directory / name
        if not path.is_file():
            raise SystemExit(f"original build seal is missing: {name}")
        snapshot[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return snapshot


def assert_seal_preserved(directory, snapshot):
    current = seal_snapshot(directory)
    for name, digest in snapshot.items():
        if current.get(name) != digest:
            raise SystemExit(f"refusing to replace original build seal {name}")


def write_acceptance_bundle(acceptance_dir, acceptance_text, acceptance):
    acceptance_dir = Path(acceptance_dir)
    if "fixture" in acceptance_dir.name.lower() or "placeholder" in acceptance_dir.name.lower():
        raise SystemExit("fixture directory cannot be published")
    acceptance_dir.mkdir(parents=True, exist_ok=True)
    (acceptance_dir / "server-acceptance.json").write_text(acceptance_text, encoding="utf-8")
    names = ["server-acceptance.json"]
    gates = acceptance.get("server_gates") if isinstance(acceptance.get("server_gates"), dict) else {}
    batch_gates = ((acceptance.get("batch") or {}).get("gates") if isinstance(acceptance.get("batch"), dict) else {}) or {}
    for collection in (gates, batch_gates):
        for name, gate in collection.items():
            relative = str(gate.get("evidence_path", ""))
            if relative != f"{name}.json" or Path(relative).name != relative:
                raise SystemExit(f"{name} evidence path is invalid")
            target = acceptance_dir / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            body = {key: value for key, value in gate.items() if key != "evidence_sha256"}
            payload = canonical_bytes(body)
            if hashlib.sha256(payload).hexdigest() != gate.get("evidence_sha256"):
                raise SystemExit(f"{name} evidence digest does not match")
            target.write_bytes(payload)
            names.append(relative)
    lines = []
    for name in sorted(set(names)):
        digest = hashlib.sha256((acceptance_dir / name).read_bytes()).hexdigest()
        lines.append(f"{digest}  {name}\n")
    (acceptance_dir / "server-acceptance.SHA256SUMS.txt").write_text("".join(lines), encoding="utf-8")


def release_contract_of(text):
    match = re.search(r'^RELEASE_CONTRACT = "([^"]+)"$', text, re.M)
    if not match:
        raise SystemExit("release contract is missing")
    return match.group(1)


def assert_same_contract(publisher_text, candidate_text):
    publisher = release_contract_of(publisher_text)
    candidate = release_contract_of(candidate_text)
    if publisher != RELEASE_CONTRACT or candidate != RELEASE_CONTRACT:
        raise SystemExit("candidate source release contract does not match the publisher")


def assert_tag_unpublished(existing_ref):
    if existing_ref:
        raise SystemExit("refusing to move an existing tag")


def assert_assets_unpublished(existing_names):
    if existing_names:
        raise SystemExit("refusing to replace published assets")


def promotion_blockers(facts):
    blockers = []
    if facts.get("rebuilt"):
        blockers.append("promotion rebuilt an image or package")
    if not facts.get("origin_verified"):
        blockers.append("candidate origin is not verified")
    blockers.extend(facts.get("acceptance_errors") or [])
    if facts.get("original_seal_changed"):
        blockers.append("original build seal changed")
    if facts.get("version") != FINAL_PRODUCT_VERSION:
        blockers.append("source version is not the final 10.1.0 product version")
    if facts.get("contract_status") != "frozen" or facts.get("contract_ref") != "api-v1.5.0":
        blockers.append("api-v1.5.0 contract is not frozen")
    if not facts.get("on_main"):
        blockers.append("main does not contain the accepted SHA")
    if facts.get("tag_exists"):
        blockers.append("refusing to move an existing tag")
    if facts.get("assets_exist"):
        blockers.append("refusing to replace published assets")
    if facts.get("event") != "workflow_dispatch":
        blockers.append("publication workflow is not workflow_dispatch")
    return blockers
