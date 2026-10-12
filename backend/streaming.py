"""Replay persisted SSE events; socket lifetime never controls the model run."""

import asyncio
import json
from time import monotonic
from uuid import UUID

import psycopg

from backend import chats


def read_batch(run_id: UUID, token: str, after: int):
    with chats.connection() as db:
        return chats.events(db, run_id, token, after)


def frame(event: dict) -> str:
    return f"id: {event['sequence']}\nevent: {event['event']}\ndata: {json.dumps(event['data'], ensure_ascii=False, separators=(',', ':'))}\n\n"


async def events(run_id: UUID, token: str, after: int):
    last_heartbeat = monotonic()
    while True:
        try:
            batch = await asyncio.to_thread(read_batch, run_id, token, after)
        except psycopg.Error:
            # Reconnect rechecks auth/scope before response headers; never fabricate an unpersisted event.
            return
        for event in batch["events"]:
            if event["sequence"] > after:
                yield frame(event)
                after = event["sequence"]
        if batch["finished"]:
            return
        if monotonic() - last_heartbeat >= 15:
            yield ": heartbeat\n\n"
            last_heartbeat = monotonic()
        await asyncio.sleep(0.3)
