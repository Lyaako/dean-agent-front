"""Password lifecycle and native user identity against the real isolated database."""
from uuid import uuid4

from psycopg import errors

from backend.database_actor import user_context
from backend.tests.test_auth import DatabaseHttpCase


class AccountSecurityTests(DatabaseHttpCase):
    def login(self, name, password="only-for-isolated-test"):
        response = self.client.post('/api/v1/auth/login',json={'login':name,'password':password},headers=self.origin)
        self.assertEqual(response.status_code,200)
        return self.origin | {'Authorization':'Bearer '+response.json()['access_token']}

    def test_reset_is_one_time_revokes_sessions_and_requires_change(self):
        admin = self.login('vasilyeva')
        teacher = self.login('novikov')
        user_id = self.client.get('/api/v1/auth/me',headers=teacher).json()['user_id']
        key = str(uuid4())
        url = f'/api/v1/admin/users/{user_id}/reset-password'
        self.assertEqual(self.client.post(url,headers=teacher|{'Idempotency-Key':key}).status_code,403)
        reset = self.client.post(url,headers=admin|{'Idempotency-Key':key})
        self.assertEqual(reset.status_code,200)
        temporary = reset.json()['temporary_password']
        self.assertGreaterEqual(len(temporary),12)
        self.assertEqual(self.client.get('/api/v1/auth/me',headers=teacher).status_code,401)
        repeated = self.client.post(url,headers=admin|{'Idempotency-Key':key})
        self.assertEqual(repeated.status_code,409)
        self.assertNotIn('temporary_password',repeated.json())
        changed = self.login('novikov',temporary)
        self.assertTrue(self.client.get('/api/v1/auth/me',headers=changed).json()['must_change_password'])
        denied = self.client.get('/api/v1/schema',headers=changed)
        self.assertEqual(denied.status_code,403)
        self.assertEqual(denied.json()['error']['code'],'password_change_required')
        response = self.client.post('/api/v1/auth/password',headers=changed,
            json={'current_password':temporary,'new_password':'isolated-new-password'})
        self.assertEqual(response.status_code,204)
        self.assertFalse(self.client.get('/api/v1/auth/me',headers=changed).json()['must_change_password'])
        self.assertEqual(self.client.get('/api/v1/schema',headers=changed).status_code,200)

    def test_profile_is_own_and_logout_all_revokes_both_sessions(self):
        first = self.login('ivanov.ks')
        second = self.login('ivanov.ks')
        profile = self.client.get('/api/v1/me/profile?student_id=999999',headers=first)
        self.assertEqual(profile.status_code,200)
        self.assertEqual(profile.json()['role'],'student')
        self.assertIn('record_book_number',profile.json())
        self.assertNotIn('passport_number',profile.json())
        self.assertEqual(self.client.post('/api/v1/auth/logout-all',headers=first).status_code,204)
        self.assertEqual(self.client.get('/api/v1/auth/me',headers=first).status_code,401)
        self.assertEqual(self.client.get('/api/v1/auth/me',headers=second).status_code,401)

    def test_native_role_identifies_actor_and_cannot_write_employees(self):
        with user_context(self.db,self.user_id):
            identity = self.db.execute("SELECT current_setting('app.user_id')::INT AS user_id,current_user AS role").fetchone()
            self.assertEqual(identity['user_id'],self.user_id)
            self.assertTrue(identity['role'].startswith('deanery_user_'))
            self.db.execute("UPDATE deanery.person SET middle_name='Проверка контекста' WHERE person_id=(SELECT person_id FROM deanery.app_user WHERE user_id=%s)",(self.user_id,))
            audit = self.db.execute("SELECT app_user_id FROM deanery.audit_log WHERE table_name='person' ORDER BY audit_id DESC LIMIT 1").fetchone()
            self.assertEqual(audit['app_user_id'],self.user_id)
            with self.assertRaises(errors.InsufficientPrivilege):
                with self.db.transaction():
                    self.db.execute('UPDATE deanery.employee SET employment_rate=employment_rate')
        self.assertEqual(self.db.execute("SELECT current_setting('role') AS role").fetchone()['role'],'backend_api')
