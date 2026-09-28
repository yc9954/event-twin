"""NAT's documented custom FastAPI worker, restricted to a local read API."""
from starlette.responses import JSONResponse
from nat.front_ends.fastapi.fastapi_front_end_plugin_worker import FastApiFrontEndPluginWorker


class LocalBoundary:
    def __init__(self, app, port=8008):
        self.app = app
        self.origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
        self.hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    async def __call__(self, scope, receive, send):
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        async def reject(status, code):
            await JSONResponse({"error": code}, status_code=status)(scope, receive, send)
        if (headers.get("host") not in self.hosts
                or (headers.get("origin") and headers["origin"] not in self.origins)
                or headers.get("sec-fetch-site") == "cross-site"):
            await reject(403, "LOCAL_BOUNDARY_REJECTED")
            return
        method, path = scope["method"], scope["path"]
        if (method, path) not in {("GET", "/health"), ("POST", "/generate"),
                                  ("GET", "/docs"), ("GET", "/openapi.json")}:
            await reject(404, "ROUTE_DISABLED")
            return
        if method == "POST":
            if headers.get("content-type", "").split(";")[0].strip() != "application/json":
                await reject(415, "JSON_REQUIRED")
                return
            body = bytearray()
            while True:
                event = await receive()
                if event["type"] == "http.disconnect":
                    return
                body.extend(event.get("body", b""))
                if len(body) > 4096:
                    await reject(413, "BODY_TOO_LARGE")
                    return
                if not event.get("more_body"):
                    break
            delivered = False
            async def bounded_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}
                return await receive()
            await self.app(scope, bounded_receive, send)
        else:
            await self.app(scope, receive, send)


class LocalReadOnlyWorker(FastApiFrontEndPluginWorker):
    def build_app(self):
        app = super().build_app()
        app.add_middleware(LocalBoundary, port=self.front_end_config.port)
        return app
