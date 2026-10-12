"""SSE formatting and detached replay without a provider or database."""

import unittest
from unittest.mock import patch
from uuid import uuid4

import psycopg

from backend import streaming


class StreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_replay_frames_only_persisted_numbers_and_never_calls_model(self):
        pages = [
            {'events': [{'sequence': 2, 'event': 'status', 'data': {'message': 'Читаю\nданные'}}], 'finished': False},
            {'events': [{'sequence': 3, 'event': 'done', 'data': {'answer': 'Готово'}}], 'finished': True},
        ]
        with patch.object(streaming, 'read_batch', side_effect=pages) as read:
            output = [chunk async for chunk in streaming.events(uuid4(), 'token', 1)]
        self.assertEqual(read.call_args_list[0].args[2], 1)
        self.assertEqual(read.call_args_list[1].args[2], 2)
        self.assertTrue(output[0].startswith('id: 2\nevent: status\ndata: '))
        self.assertIn('Читаю\\nданные', output[0])
        self.assertTrue(output[1].startswith('id: 3\nevent: done'))

    async def test_disconnect_only_closes_reader_and_scope_failure_leaks_no_cached_event(self):
        page = {'events': [{'sequence': 1, 'event': 'session', 'data': {'run_id': 'fixture'}}], 'finished': False}
        with patch.object(streaming, 'read_batch', return_value=page) as read:
            stream = streaming.events(uuid4(), 'token', 0)
            await anext(stream)
            await stream.aclose()
            self.assertEqual(read.call_count, 1)
        with patch.object(streaming, 'read_batch', side_effect=psycopg.errors.InsufficientPrivilege()):
            self.assertEqual([chunk async for chunk in streaming.events(uuid4(), 'token', 0)], [])
