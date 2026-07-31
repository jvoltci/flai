import { useState } from 'react';
import type { ApiClient } from '../api';

interface SignInProps {
  api: ApiClient;
  onSignedIn: () => void;
}

/* One field, once per tab. v3 asked for the password on every single fetch and posted it in
 * the body each time; now it buys a 12-hour token that the stream URLs carry too. */
export const SignIn = ({ api, onSignedIn }: SignInProps) => {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.signIn(password);
      setPassword('');
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="n-card n-card-pad n-stack" aria-labelledby="signin-title">
      <div className="n-stack flai-tight">
        <h2 className="flai-title" id="signin-title">
          Sign in
        </h2>
        <p className="n-hint">
          flai-api is gated so the bandwidth bill stays with whoever runs it. The password is
          exchanged for a 12-hour token and is never stored.
        </p>
      </div>

      <form onSubmit={submit} className="n-stack">
        <div className="n-field">
          <label className="n-label" data-required htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="n-input"
            type="password"
            required
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'password-error' : undefined}
          />
          {error && (
            <p className="n-error" id="password-error">
              {error}
            </p>
          )}
        </div>
        <div className="n-cluster">
          <button type="submit" className="n-btn n-btn-fill n-btn-lg" aria-busy={busy}>
            Sign in
          </button>
        </div>
      </form>
    </section>
  );
};
