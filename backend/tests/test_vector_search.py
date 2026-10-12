"""Focused embedding and real Qdrant protocol boundaries; fake vectors are labeled."""

from hashlib import sha256
import math
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from backend import vector_search as vectors


def settings():
    return SimpleNamespace(bge_url="http://bge", qdrant_url="http://qdrant", qdrant_collection="test_norms",
                           embedding_revision="test-revision", vector_timeout=2)


def embedding(**updates):
    return {"model": vectors.MODEL, "revision": "test-revision", "vector": [0.01] * 1024,
            "sparse": {"1": 0.5, "3": 0.25}, **updates}


def install_transport(monkeypatch, handler):
    client = httpx.Client
    monkeypatch.setattr(vectors.httpx, "Client", lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs))


@pytest.mark.parametrize("bad", [{"vector": [1.0]}, {"vector": [float("inf")] * 1024}, {"sparse": {}},
                                  {"sparse": {"-1": 0.1}}, {"sparse": {"1": -0.5}}, {"sparse": {"01": 0.5}}])
def test_malformed_or_dense_only_embedding_never_succeeds(bad):
    with pytest.raises(vectors.KnowledgeError, match="knowledge_embedding_invalid"):
        vectors._vector(embedding(**bad))


def test_model_revision_and_network_failures_are_explicit(monkeypatch):
    install_transport(monkeypatch, lambda request: httpx.Response(200, json=embedding(revision="wrong")))
    with pytest.raises(vectors.KnowledgeError, match="knowledge_embedding_incompatible"):
        vectors.embed_texts(["Норма"], settings=settings())
    with pytest.raises(vectors.KnowledgeError, match="knowledge_invalid_query"):
        vectors.search_candidates("x" * 301, {"is_admin": True}, settings=settings())


@pytest.mark.parametrize("body", [[], None, "wrong", 1])
def test_non_object_dependency_json_is_explicit(monkeypatch, body):
    install_transport(monkeypatch, lambda request: httpx.Response(200, json=body))
    with pytest.raises(vectors.KnowledgeError, match="knowledge_unavailable"):
        vectors.embed_texts(["Норма"], settings=settings())


def test_exact_hybrid_rrf_query_and_untrusted_payload_not_returned(monkeypatch):
    calls = []
    ids = {key: str(uuid4()) for key in ("chunk_id", "version_id", "generation_id")}
    def request(req):
        import json
        calls.append((req.url.path, json.loads(req.content) if req.content else None))
        if req.url.path == "/predict":
            return httpx.Response(200, json=embedding())
        if req.method == "GET":
            return httpx.Response(200, json={"result": {"config": {"params": {"vectors": {"dense": {"size": 1024, "distance": "Cosine"}}, "sparse_vectors": {"sparse": {}}}}}})
        return httpx.Response(200, json={"result": {"points": [{"payload": {**ids, "text_hash": "a" * 64,
            "model": vectors.MODEL, "revision": "test-revision", "text": "Injected payload", "source_url": "https://evil.test"}, "score": 0.3}]}})
    install_transport(monkeypatch, request)
    results = vectors.search_candidates("академическая задолженность", {"is_admin": False, "institute_ids": [2], "generation_ids": [ids["generation_id"]]}, settings=settings())
    body = calls[-1][1]
    assert body["query"] == {"fusion": "rrf"} and [p["using"] for p in body["prefetch"]] == ["dense", "sparse"]
    assert all(p["filter"] == body["filter"] for p in body["prefetch"])
    assert body["filter"]["must"][0] == {"key": "generation_id", "match": {"any": [ids["generation_id"]]}}
    assert results == [{**ids, "text_hash": "a" * 64, "score": 0.3}]


def test_missing_collection_is_distinct_from_successful_empty_search(monkeypatch):
    missing = True
    def request(req):
        if req.url.path == "/predict":
            return httpx.Response(200, json=embedding())
        if req.method == "GET":
            return httpx.Response(404) if missing else httpx.Response(200, json={"result": {"config": {"params": {
                "vectors": {"dense": {"size": 1024, "distance": "Cosine"}}, "sparse_vectors": {"sparse": {}}}}}})
        return httpx.Response(200, json={"result": {"points": []}})
    install_transport(monkeypatch, request)
    with pytest.raises(vectors.KnowledgeError, match="knowledge_index_missing"):
        vectors.search_candidates("Норма", {"is_admin": True, "generation_ids": [str(uuid4())]}, settings=settings())
    missing = False
    assert vectors.search_candidates("Норма", {"is_admin": True, "generation_ids": [str(uuid4())]}, settings=settings()) == []


@pytest.mark.parametrize("corruption", ["payload", "dense", "dense_bool", "sparse", "shape"])
def test_candidate_publication_receipt_requires_remote_point_verification(monkeypatch, corruption):
    saved, corrupt = {}, False
    def request(req):
        import json
        body = json.loads(req.content) if req.content else None
        if req.url.path == "/predict":
            return httpx.Response(200, json=embedding())
        if req.method == "GET":
            return httpx.Response(200, json={"result": {"config": {"params": {"vectors": {"dense": {"size": 1024, "distance": "Cosine"}}, "sparse_vectors": {"sparse": {}}}}}})
        if req.method == "PUT":
            saved.update(body["points"][0])
            dense = saved["vector"]["dense"]
            saved["vector"]["dense"] = [v / math.hypot(*dense) for v in dense]
            return httpx.Response(200, json={"result": {"status": "completed"}})
        if req.url.path.endswith("/count"):
            return httpx.Response(200, json={"result": {"count": 1}})
        result = dict(saved)
        if corrupt:
            if corruption == "payload":
                result["payload"] = {**saved["payload"], "text_hash": "0" * 64}
            elif corruption == "dense":
                result["vector"] = {**saved["vector"], "dense": [-v for v in saved["vector"]["dense"]]}
            elif corruption == "dense_bool":
                result["vector"] = {**saved["vector"], "dense": [True] * 1024}
            elif corruption == "sparse":
                result["vector"] = {**saved["vector"], "sparse": {"indices": [1, 3], "values": [0.5, 0.9]}}
            else:
                result["vector"] = None
        return httpx.Response(200, json={"result": [result]})
    install_transport(monkeypatch, request)
    chunk = {"chunk_id": str(uuid4()), "sequence": 0, "text": "Норма", "text_hash": sha256("Норма".encode()).hexdigest()}
    descriptor = {"regulation_id": str(uuid4()), "version_id": str(uuid4()), "source": "Synthetic", "scope": {"global": True, "institute_ids": []}}
    generation = str(uuid4())
    result = vectors.index_generation(descriptor, [chunk], generation, settings=settings())
    assert result["chunk_count"] == 1 and result["manifest_hash"] == sha256(f"{chunk['chunk_id']}:{chunk['text_hash']}".encode()).hexdigest()
    corrupt = True
    with pytest.raises(vectors.KnowledgeError, match="knowledge_index_incomplete"):
        vectors.index_generation(descriptor, [chunk], generation, settings=settings())
