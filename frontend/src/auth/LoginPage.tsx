import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthProvider";
import { errorText } from "../api/errors";

export function LoginPage() {
  const { login } = useAuth();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(name.trim(), password);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand">
          <span className="orb logo-orb" aria-hidden="true" />
          <b>Деканат</b>
        </div>
        <h1>Вход</h1>
        <label className="field">
          <span>Логин</span>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label className="field">
          <span>Пароль</span>
          <input className="text-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy || !name.trim() || !password}>{busy ? "Входим…" : "Войти"}</button>
      </form>
    </div>
  );
}
