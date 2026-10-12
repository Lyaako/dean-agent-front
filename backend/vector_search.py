"""BGE-M3 dense/lexical embeddings and an isolated, generation-bound Qdrant index."""

from hashlib import sha256
import math
import re
from uuid import UUID, uuid5

import httpx


MODEL = "BAAI/bge-m3"
DIMENSIONS = 1024
MAX_TEXT_CHARS = 2000
SEARCH_LIMIT = 12


class KnowledgeError(RuntimeError):
    """A safe dependency error code, never a backend response or source excerpt."""


def _request(client, method, url, *, code, body=None, missing=False):
    try:
        with client.stream(method, url, json=body) as response:
            if missing and response.status_code == 404:
                return None
            response.raise_for_status()
            data = bytearray()
            for part in response.iter_bytes():
                data.extend(part)
                if len(data) > 4_000_000:
                    raise KnowledgeError(code)
            import json
            result = json.loads(data)
            if not isinstance(result, dict):
                raise KnowledgeError(code)
            return result
    except (httpx.HTTPError, ValueError, TypeError):
        raise KnowledgeError(code) from None


def _vector(value):
    try:
        dense, sparse = value["vector"], value["sparse"]
        if (not isinstance(dense, list) or len(dense) != DIMENSIONS
                or any(isinstance(x, bool) or not isinstance(x, (float, int)) or not math.isfinite(x) for x in dense)
                or not any(dense) or not isinstance(sparse, dict) or not sparse or len(sparse) > 8192):
            raise ValueError
        if any(not re.fullmatch(r"0|[1-9][0-9]{0,8}", str(k)) or int(k) > 250001
               or isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) or v <= 0
               for k, v in sparse.items()):
            raise ValueError
        return {"dense": dense, "sparse": sparse}
    except (KeyError, TypeError, ValueError):
        raise KnowledgeError("knowledge_embedding_invalid") from None


def embed_texts(texts, *, settings, check=lambda: None):
    if not isinstance(texts, list) or not texts or any(not isinstance(t, str) or not t.strip() or len(t) > MAX_TEXT_CHARS for t in texts):
        raise KnowledgeError("knowledge_invalid_text")
    vectors = []
    with httpx.Client(timeout=settings.vector_timeout, trust_env=False) as client:
        for text in texts:
            check()
            result = _request(client, "POST", settings.bge_url.rstrip("/") + "/predict", code="knowledge_unavailable",
                              body={"text": text, "return_dense": True, "return_sparse": True, "return_colbert_vecs": False})
            check()
            if result.get("model") != MODEL or result.get("revision") != settings.embedding_revision:
                raise KnowledgeError("knowledge_embedding_incompatible")
            vectors.append(_vector(result))
    return vectors


def _collection(client, settings, *, create=False):
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", settings.qdrant_collection):
        raise KnowledgeError("knowledge_index_incompatible")
    url = settings.qdrant_url.rstrip("/") + "/collections/" + settings.qdrant_collection
    info = _request(client, "GET", url, code="knowledge_index_unavailable", missing=True)
    if info is None and create:
        _request(client, "PUT", url, code="knowledge_index_unavailable", body={
            "vectors": {"dense": {"size": DIMENSIONS, "distance": "Cosine", "on_disk": True}},
            "sparse_vectors": {"sparse": {"index": {"on_disk": True}}}, "on_disk_payload": True})
        info = _request(client, "GET", url, code="knowledge_index_unavailable")
    if info is None:
        raise KnowledgeError("knowledge_index_missing")
    try:
        params = info["result"]["config"]["params"]
        if (params["vectors"]["dense"]["size"] != DIMENSIONS or params["vectors"]["dense"]["distance"] != "Cosine"
                or "sparse" not in params["sparse_vectors"]):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise KnowledgeError("knowledge_index_incompatible") from None
    return url


def _sparse(weights):
    items = sorted((int(k), v) for k, v in weights.items())
    return {"indices": [k for k, _ in items], "values": [v for _, v in items]}


def index_generation(descriptor, chunks, generation_id, *, settings, check=lambda: None):
    generation = UUID(str(generation_id))
    ordered = sorted(chunks, key=lambda c: c["sequence"])
    if not ordered or len({c["chunk_id"] for c in ordered}) != len(ordered):
        raise KnowledgeError("knowledge_invalid_chunks")
    manifest = sha256("\n".join(f"{c['chunk_id']}:{c['text_hash']}" for c in ordered).encode()).hexdigest()
    with httpx.Client(timeout=settings.vector_timeout, trust_env=False) as client:
        check()
        url = _collection(client, settings, create=True)
        for chunk in ordered:
            if sha256(chunk["text"].encode()).hexdigest() != chunk["text_hash"]:
                raise KnowledgeError("knowledge_invalid_chunks")
            vector = embed_texts([chunk["text"]], settings=settings, check=check)[0]
            payload = {key: str(descriptor[key]) for key in ("regulation_id", "version_id")}
            payload.update(chunk_id=str(chunk["chunk_id"]), generation_id=str(generation), text_hash=chunk["text_hash"],
                           source=descriptor["source"], scope=descriptor["scope"], model=MODEL, revision=settings.embedding_revision)
            point = {"id": str(uuid5(generation, str(chunk["chunk_id"]))), "payload": payload,
                     "vector": {"dense": vector["dense"], "sparse": _sparse(vector["sparse"])}}
            check()
            written = _request(client, "PUT", url + "/points?wait=true", code="knowledge_index_unavailable", body={"points": [point]})
            check()
            if not isinstance(written.get("result"), dict) or written["result"].get("status") != "completed":
                raise KnowledgeError("knowledge_index_incomplete")
            verified = _request(client, "POST", url + "/points", code="knowledge_index_unavailable",
                                body={"ids": [point["id"]], "with_payload": True, "with_vector": True})
            check()
            records = verified.get("result", [])
            if (not isinstance(records, list) or len(records) != 1 or not isinstance(records[0], dict)
                    or records[0].get("id") != point["id"] or records[0].get("payload") != payload):
                raise KnowledgeError("knowledge_index_incomplete")
            saved = records[0].get("vector", {})
            try:
                # Qdrant stores cosine vectors normalized to unit length.
                norm = math.hypot(*vector["dense"])
                if (len(saved["dense"]) != DIMENSIONS or any(isinstance(a, bool) or not math.isclose(a, b / norm, rel_tol=1e-5, abs_tol=1e-7)
                        for a, b in zip(saved["dense"], vector["dense"]))
                        or saved["sparse"]["indices"] != point["vector"]["sparse"]["indices"]
                        or len(saved["sparse"]["values"]) != len(point["vector"]["sparse"]["values"])
                        or any(isinstance(a, bool) or not math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-7)
                               for a, b in zip(saved["sparse"]["values"], point["vector"]["sparse"]["values"]))):
                    raise ValueError
            except (KeyError, TypeError, ValueError):
                raise KnowledgeError("knowledge_index_incomplete") from None
        counted = _request(client, "POST", url + "/points/count", code="knowledge_index_unavailable", body={
            "filter": {"must": [{"key": "version_id", "match": {"value": str(descriptor["version_id"])}},
                                {"key": "generation_id", "match": {"value": str(generation)}}]}, "exact": True})
        check()
        if not isinstance(counted.get("result"), dict) or counted["result"].get("count") != len(ordered):
            raise KnowledgeError("knowledge_index_incomplete")
    return {"generation_id": str(generation), "chunk_count": len(ordered), "manifest_hash": manifest,
            "model_revision": settings.embedding_revision}


def search_candidates(query, scope, *, settings, check=lambda: None):
    if not isinstance(query, str) or not query.strip() or len(query) > 300:
        raise KnowledgeError("knowledge_invalid_query")
    generations = scope["generation_ids"]
    if not generations:
        return []
    vector = embed_texts([query], settings=settings, check=check)[0]
    allowed = {"must": [{"key": "generation_id", "match": {"any": generations}}]}
    if not scope["is_admin"]:
        allowed["must"].append({"should": [{"key": "scope.global", "match": {"value": True}},
            {"key": "scope.institute_ids", "match": {"any": scope["institute_ids"]}}]})
    with httpx.Client(timeout=settings.vector_timeout, trust_env=False) as client:
        check()
        url = _collection(client, settings)
        prefetch = [{"query": vector["dense"], "using": "dense", "limit": SEARCH_LIMIT * 3},
                    {"query": _sparse(vector["sparse"]), "using": "sparse", "limit": SEARCH_LIMIT * 3}]
        for item in prefetch:
            item["filter"] = allowed
        result = _request(client, "POST", url + "/points/query", code="knowledge_index_unavailable", body={
            "prefetch": prefetch, "query": {"fusion": "rrf"}, "limit": SEARCH_LIMIT, "with_payload": True,
            "with_vector": False, "filter": allowed})
        check()
    try:
        candidates = []
        for point in result["result"]["points"]:
            payload = point["payload"]
            candidate = {k: str(UUID(payload[k])) for k in ("chunk_id", "version_id", "generation_id")}
            if payload.get("model") != MODEL or payload.get("revision") != settings.embedding_revision:
                continue
            if not re.fullmatch(r"[a-f0-9]{64}", payload["text_hash"]) or not math.isfinite(point["score"]):
                raise ValueError
            candidate.update(text_hash=payload["text_hash"], score=point["score"])
            candidates.append(candidate)
        return candidates
    except (KeyError, TypeError, ValueError):
        raise KnowledgeError("knowledge_index_incompatible") from None
