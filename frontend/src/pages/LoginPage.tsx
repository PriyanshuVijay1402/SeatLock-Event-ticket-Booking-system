import { useState } from 'react';
import { ErrorBox, useAuth } from '../App';

export default function LoginPage() {
  const { login } = useAuth();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await login(name);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="mx-auto mt-16 max-w-sm rounded-lg border bg-white p-6">
      <h1 className="text-lg font-semibold">Log in</h1>
      <p className="mt-1 text-sm text-slate-500">
        Mock login: any name creates a user. Use <b>admin</b> for the admin panel, or <b>alice</b> / <b>bob</b>.
      </p>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          className="w-full rounded-md border px-3 py-2"
        />
        <ErrorBox error={error} />
        <button disabled={!name.trim()} className="w-full rounded-md bg-slate-900 py-2 text-white disabled:opacity-40">
          Continue
        </button>
      </form>
    </div>
  );
}
