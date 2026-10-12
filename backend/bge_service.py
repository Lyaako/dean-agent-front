"""Single-request, CPU-only official BGE-M3 inference for the private knowledge worker."""

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os


MODEL = "BAAI/bge-m3"
REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
MAX_LENGTH = 2048
MAX_BYTES = 12000


def main():
    import torch
    from FlagEmbedding import BGEM3FlagModel

    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    model = BGEM3FlagModel(os.environ.get("BGE_MODEL_PATH", "/model"), use_fp16=False, devices="cpu")
    model.model.eval()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *args):
            pass  # Source text and request details do not belong in container logs.

        def reply(self, status, result):
            body = json.dumps(result, separators=(",", ":"), allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.reply(200 if self.path == "/health" else 404,
                       {"ready": True, "model": MODEL, "revision": REVISION, "dense_dimensions": 1024,
                        "sparse": True, "max_tokens": MAX_LENGTH, "device": "cpu", "precision": "float32"})

        def do_POST(self):
            if self.path != "/predict":
                return self.reply(404, {"error": "not_found"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size < 1 or size > MAX_BYTES or self.headers.get("Transfer-Encoding"):
                    return self.reply(413, {"error": "invalid_size"})
                request = json.loads(self.rfile.read(size))
                text = request.get("text")
                if (set(request) != {"text", "return_dense", "return_sparse", "return_colbert_vecs"}
                        or request["return_dense"] is not True or request["return_sparse"] is not True
                        or request["return_colbert_vecs"] is not False or not isinstance(text, str)
                        or not text.strip() or len(text) > 2000):
                    return self.reply(422, {"error": "invalid_text"})
                tokens = model.tokenizer(text, truncation=False, add_special_tokens=True)["input_ids"]
                if len(tokens) > MAX_LENGTH:
                    return self.reply(422, {"error": "token_limit"})
                with torch.inference_mode():
                    result = model.encode([text], batch_size=1, max_length=MAX_LENGTH,
                                          return_dense=True, return_sparse=True, return_colbert_vecs=False)
                dense = result["dense_vecs"][0].tolist()
                sparse = {str(k): float(v) for k, v in result["lexical_weights"][0].items()}
                if len(dense) != 1024 or not sparse:
                    return self.reply(503, {"error": "embedding_invalid"})
                self.reply(200, {"model": MODEL, "revision": REVISION, "vector": dense, "sparse": sparse})
            except (ValueError, TypeError, KeyError):
                self.reply(422, {"error": "invalid_request"})
            except Exception:
                self.reply(503, {"error": "embedding_unavailable"})

    HTTPServer(("0.0.0.0", 8087), Handler).serve_forever()


if __name__ == "__main__":
    main()
