import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { generateKeyPair, savePrivateKey } from '../utils/crypto';
import api from '../utils/api';

export default function LoginPage() {
  const [mode, setMode]     = useState('login');
  const [form, setForm]     = useState({ username: '', email: '', password: '' });
  const [error, setError]   = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep]     = useState('');
  const { login, register } = useAuth();
  const navigate = useNavigate();

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (mode === 'register') {
        setStep('Creating account...');
        await register(form.username, form.email, form.password);

        setStep('Generating RSA-2048 key pair in your browser...');
        const keys = await generateKeyPair();
        savePrivateKey(keys.privateKey);

        setStep('Publishing your public key...');
        await api.post('/keys/upload', { public_key: keys.publicKey });

        navigate('/');
      } else {
        setStep('Signing in...');
        await login(form.email, form.password);
        navigate('/');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
      setStep('');
    }
  };

  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={s.logo}>
          phantom<span style={{ color: '#4a5568' }}>mail</span>
        </div>
        <p style={s.tagline}>Metadata-minimized · End-to-end encrypted</p>

        {/* Tabs */}
        <div style={s.tabs}>
          {['login', 'register'].map(m => (
            <button
              key={m}
              style={{ ...s.tab, ...(mode === m ? s.tabOn : {}) }}
              onClick={() => { setMode(m); setError(''); }}
            >
              {m === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} style={s.form}>
          {mode === 'register' && (
            <input style={s.input} placeholder="Username" value={form.username}
              onChange={set('username')} required autoComplete="username" />
          )}
          <input style={s.input} type="email" placeholder="Email"
            value={form.email} onChange={set('email')} required autoComplete="email" />
          <input style={s.input} type="password" placeholder="Password (min 8 characters)"
            value={form.password} onChange={set('password')} required autoComplete="current-password" />

          {error && <div style={s.errorBox}>{error}</div>}
          {step  && <div style={s.stepBox}>{step}</div>}

          <button style={{ ...s.btn, opacity: loading ? 0.7 : 1 }} type="submit" disabled={loading}>
            {loading ? step || '...' : mode === 'login' ? '🔒 Sign In' : '🔑 Create Account'}
          </button>
        </form>

        {mode === 'register' && (
          <div style={s.privacyNote}>
            <p>🔐 <strong>How your keys work:</strong></p>
            <p>On sign-up, an RSA-2048 key pair is generated entirely in your browser. Your <strong>private key never leaves your device</strong>. The server only stores your public key — it cannot decrypt any of your messages.</p>
          </div>
        )}
      </div>
    </div>
  );
}

const s = {
  page: {
    minHeight: '100vh', background: '#0a0b0e', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    fontFamily: "'IBM Plex Sans', sans-serif",
  },
  card: {
    background: '#111318', border: '1px solid #232839', borderRadius: '14px',
    padding: '40px 36px', width: '400px', maxWidth: '92vw',
  },
  logo: {
    fontFamily: "'IBM Plex Mono', monospace", fontSize: '26px',
    fontWeight: '700', color: '#00e5a0', marginBottom: '6px',
  },
  tagline: {
    color: '#4a5568', fontSize: '11px', marginBottom: '28px',
    fontFamily: "'IBM Plex Mono', monospace", letterSpacing: '0.3px',
  },
  tabs: { display: 'flex', gap: '8px', marginBottom: '24px' },
  tab: {
    flex: 1, padding: '9px', background: 'none',
    border: '1px solid #232839', borderRadius: '6px',
    color: '#8892a4', cursor: 'pointer', fontSize: '13px',
    fontFamily: "'IBM Plex Sans', sans-serif",
  },
  tabOn: { borderColor: '#00e5a0', color: '#00e5a0', background: 'rgba(0,229,160,0.07)' },
  form: { display: 'flex', flexDirection: 'column', gap: '12px' },
  input: {
    padding: '11px 13px', background: '#171b22', border: '1px solid #232839',
    borderRadius: '7px', color: '#e8eaf0', fontSize: '13px', outline: 'none',
    fontFamily: 'inherit', transition: 'border-color .15s',
  },
  btn: {
    padding: '12px', background: '#00e5a0', border: 'none', borderRadius: '7px',
    color: '#000', fontWeight: '700', fontSize: '14px', cursor: 'pointer',
    marginTop: '4px', fontFamily: 'inherit',
  },
  errorBox: {
    background: 'rgba(255,68,68,0.08)', border: '1px solid rgba(255,68,68,0.3)',
    borderRadius: '6px', padding: '10px 13px', color: '#ff8888', fontSize: '12px',
  },
  stepBox: {
    color: '#00e5a0', fontSize: '12px', fontFamily: "'IBM Plex Mono', monospace",
    padding: '6px 0',
  },
  privacyNote: {
    marginTop: '20px', padding: '14px', background: 'rgba(0,102,255,0.06)',
    border: '1px solid rgba(0,102,255,0.2)', borderRadius: '8px',
    fontSize: '12px', color: '#8892a4', lineHeight: '1.7', display: 'flex',
    flexDirection: 'column', gap: '6px',
  },
};
