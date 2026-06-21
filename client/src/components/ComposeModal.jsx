import { useState, useEffect } from 'react';
import api from '../utils/api';
import { encryptMessage, encryptFile } from '../utils/crypto';

export default function ComposeModal({ onClose, onSent, defaultTo = '' }) {
  const [form, setForm] = useState({
    to: defaultTo, subject: '', body: '',
    hops: 3, ttl: 'never',
  });
  const [attachments, setAttachments] = useState([]);
  const [status, setStatus] = useState('');
  const [error,  setError]  = useState('');
  const [busy,   setBusy]   = useState(false);
  const [recipientOnline, setRecipientOnline] = useState(null); // null, true, false
  const [lookupError, setLookupError] = useState('');

  const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB limit

  // Debounced lookup of recipient alias status
  useEffect(() => {
    const toTrimmed = form.to.trim();
    if (!toTrimmed || !toTrimmed.includes('-')) {
      Promise.resolve().then(() => {
        setRecipientOnline(null);
        setLookupError('');
      });
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await api.get(`/keys/${toTrimmed}`);
        setRecipientOnline(res.data.online);
        setLookupError('');
      } catch {
        setRecipientOnline(null);
        setLookupError('Recipient not found');
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [form.to]);

  const set = (field) => (e) =>
    setForm({ ...form, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files);
    const oversized = files.find(f => f.size > MAX_FILE_SIZE);
    if (oversized) {
      setError(`File "${oversized.name}" exceeds the 25MB limit.`);
      e.target.value = null; // reset
      return;
    }
    setError('');
    setAttachments(prev => [...prev, ...files]);
    e.target.value = null;
  };

  const removeAttachment = (index) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const send = async () => {
    if (!form.to.trim() || !form.body.trim()) return;
    setError(''); setBusy(true);

    try {
      // Step 1: fetch recipient's public key
      setStatus('Looking up recipient…');
      let pubKey;
      try {
        const res = await api.get(`/keys/${form.to.trim()}`);
        pubKey = res.data.public_key;
      } catch {
        throw new Error('Recipient alias not found or has no public key yet.');
      }

      // Step 2: encrypt everything in the browser — server never sees plaintext
      setStatus('Encrypting in your browser…');
      const subjectEncrypted = await encryptMessage(
        form.subject.trim() || '(no subject)', pubKey
      );
      const bodyEncrypted = await encryptMessage(form.body, pubKey);

      let attachmentMetadata = [];
      let encryptedBlobs = [];
      
      if (attachments.length > 0) {
        setStatus('Encrypting attachments…');
        for (const file of attachments) {
          const { encryptedBlob, metadata } = await encryptFile(file, pubKey);
          encryptedBlobs.push(encryptedBlob);
          attachmentMetadata.push({
             ...metadata,
             file_size: file.size
          });
        }
      }

      // Step 3: send the ciphertext to server
      setStatus('Sending through relay…');
      const isEphemeral = form.ttl !== 'never';
      let expiresAt = null;
      if (isEphemeral) {
        const hours = form.ttl === '1h' ? 1 : form.ttl === '24h' ? 24 : 168;
        expiresAt = Date.now() + hours * 3600 * 1000;
      }

      const formData = new FormData();
      formData.append('recipient_alias', form.to.trim());
      formData.append('subject_encrypted', subjectEncrypted);
      formData.append('body_encrypted', bodyEncrypted);
      formData.append('routing_hops', form.hops);
      formData.append('is_ephemeral', isEphemeral);
      if (expiresAt) formData.append('expires_at', expiresAt);

      if (encryptedBlobs.length > 0) {
        formData.append('attachment_metadata', JSON.stringify(attachmentMetadata));
        encryptedBlobs.forEach((blob, i) => {
          formData.append('attachments', blob, `attachment_${i}.bin`);
        });
      }

      await api.post('/messages/send', formData);

      setStatus('✓ Delivered');
      setTimeout(() => { onSent(); onClose(); }, 700);

    } catch (err) {
      setError(err.message || err.response?.data?.error || 'Failed to send. Try again.');
      setBusy(false); setStatus('');
    }
  };

  return (
    <div style={s.backdrop}>
      <div style={s.modal}>

        {/* Header */}
        <div style={s.header}>
          <span style={s.title}>New Encrypted Message</span>
          <button style={s.closeBtn} onClick={onClose}>×</button>
        </div>

        {/* Fields */}
        <div style={s.field}>
          <label style={s.label}>To</label>
          <input style={s.fieldInput} value={form.to} onChange={set('to')}
            placeholder="recipient-alias  (e.g. ghost-7f3a2b)" autoFocus />
          {recipientOnline !== null && (
            <span style={{ fontSize: '11px', color: recipientOnline ? '#00e5a0' : '#8892a4', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
              ● {recipientOnline ? 'Online' : 'Offline'}
            </span>
          )}
          {lookupError && (
            <span style={{ fontSize: '11px', color: '#ff8888', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
              ⚠ Not found
            </span>
          )}
        </div>
        <div style={s.field}>
          <label style={s.label}>Subject</label>
          <input style={s.fieldInput} value={form.subject} onChange={set('subject')}
            placeholder="Subject (optional)" />
        </div>
        <div style={s.field}>
          <label style={s.label}>Hops</label>
          <select style={{ ...s.fieldInput, cursor: 'pointer' }} value={form.hops}
            onChange={(e) => setForm({ ...form, hops: +e.target.value })}>
            <option value={2}>2 hops — faster</option>
            <option value={3}>3 hops — balanced (recommended)</option>
            <option value={4}>4 hops — more private</option>
            <option value={5}>5 hops — maximum privacy</option>
          </select>
        </div>

        {/* Body */}
        <textarea style={s.body} value={form.body} onChange={set('body')}
          placeholder="Write your message…&#10;&#10;It will be encrypted with AES-256 in your browser before leaving your device. The server only ever sees ciphertext." />

        {/* Attachments UI */}
        {attachments.length > 0 && (
          <div style={s.attachmentsBox}>
            {attachments.map((file, i) => (
              <div key={i} style={s.attachmentPill}>
                <span style={s.attachmentName}>{file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                <button style={s.attachmentRemove} onClick={() => removeAttachment(i)}>×</button>
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div style={s.footer}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <label style={{ fontSize: '12px', color: '#8892a4', fontFamily: 'inherit' }}>TTL:</label>
            <select
              style={{
                background: '#171b22', border: '1px solid #232839', color: '#e8eaf0',
                borderRadius: '4px', fontSize: '12px', padding: '4px 8px', cursor: 'pointer', outline: 'none'
              }}
              value={form.ttl}
              onChange={(e) => setForm({ ...form, ttl: e.target.value })}
            >
              <option value="never">No Expiry</option>
              <option value="1h">1 Hour</option>
              <option value="24h">24 Hours</option>
              <option value="7d">7 Days</option>
            </select>
          </div>

          <div style={{ display: 'flex', gap: '6px', marginLeft: 'auto', alignItems: 'center' }}>
            <label style={s.attachLabel}>
              📎 Attach
              <input type="file" multiple onChange={handleFileChange} style={{ display: 'none' }} />
            </label>
            {status && <span style={s.statusText}>{status}</span>}
            {error  && <span style={s.errorText}>{error}</span>}
            <button style={{ ...s.sendBtn, opacity: busy ? 0.7 : 1 }}
              onClick={send} disabled={busy || !form.to.trim() || !form.body.trim()}>
              {busy ? '…' : '🔒 Encrypt & Send'}
            </button>
          </div>
        </div>

        {/* Encryption badge row */}
        <div style={s.badgeRow}>
          <span style={s.badge('#00e5a0')}>E2E Encrypted</span>
          <span style={s.badge('#6a9fff')}>{form.hops} Relay Hops</span>
          {form.ttl !== 'never' && <span style={s.badge('#ff8888')}>Ephemeral ({form.ttl})</span>}
          <span style={{ marginLeft: 'auto', fontSize: '10px', color: '#4a5568', fontFamily: 'monospace' }}>
            Private key never leaves your device
          </span>
        </div>

      </div>
    </div>
  );
}

const s = {
  backdrop: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 300, fontFamily: "'IBM Plex Sans', sans-serif",
  },
  modal: {
    background: '#171b22', border: '1px solid #232839', borderRadius: '12px',
    width: '540px', maxWidth: '95vw', display: 'flex', flexDirection: 'column',
    boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
  },
  header: {
    display: 'flex', alignItems: 'center', padding: '14px 18px',
    background: '#1e2330', borderRadius: '12px 12px 0 0',
    borderBottom: '1px solid #232839',
  },
  title: { fontWeight: '600', fontSize: '14px', flex: 1, color: '#e8eaf0' },
  closeBtn: {
    background: 'none', border: 'none', color: '#8892a4',
    cursor: 'pointer', fontSize: '22px', lineHeight: 1, padding: '0 2px',
  },
  field: {
    display: 'flex', alignItems: 'center', padding: '9px 16px',
    borderBottom: '1px solid #232839', gap: '10px',
  },
  label: {
    color: '#4a5568', fontFamily: "'IBM Plex Mono', monospace",
    fontSize: '11px', width: '54px', flexShrink: 0,
  },
  fieldInput: {
    flex: 1, background: 'none', border: 'none', outline: 'none',
    color: '#e8eaf0', fontSize: '13px', fontFamily: 'inherit',
  },
  body: {
    flex: 1, margin: '12px 16px', minHeight: '150px', background: 'none',
    border: 'none', outline: 'none', color: '#e8eaf0', fontSize: '13px',
    fontFamily: "'IBM Plex Sans', sans-serif", resize: 'vertical', lineHeight: '1.65',
  },
  attachmentsBox: {
    margin: '0 16px 12px 16px', padding: '8px', background: 'rgba(0,0,0,0.2)',
    borderRadius: '6px', border: '1px solid #232839', display: 'flex', flexWrap: 'wrap', gap: '6px'
  },
  attachmentPill: {
    display: 'flex', alignItems: 'center', gap: '6px', background: '#111318',
    padding: '4px 8px', borderRadius: '4px', border: '1px solid #232839'
  },
  attachmentName: { fontSize: '11px', color: '#8892a4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' },
  attachmentRemove: { background: 'none', border: 'none', color: '#ff8888', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '0 2px' },
  footer: {
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '11px 16px', borderTop: '1px solid #232839', flexWrap: 'wrap',
  },
  ephemeralLabel: { fontSize: '12px', color: '#8892a4', cursor: 'pointer', display: 'flex', alignItems: 'center' },
  attachLabel: {
    fontSize: '13px', color: '#e8eaf0', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
    background: '#111318', padding: '8px 12px', borderRadius: '6px', border: '1px solid #232839'
  },
  sendBtn: {
    background: '#00e5a0', color: '#000', border: 'none', borderRadius: '6px',
    padding: '9px 18px', fontWeight: '700', fontSize: '13px', cursor: 'pointer',
    fontFamily: 'inherit',
  },
  statusText: { fontSize: '11px', color: '#00e5a0', fontFamily: 'monospace' },
  errorText:  { fontSize: '11px', color: '#ff8888' },
  badgeRow: {
    display: 'flex', alignItems: 'center', gap: '6px',
    padding: '8px 16px', borderTop: '1px solid #232839',
    background: 'rgba(0,0,0,0.2)', borderRadius: '0 0 12px 12px',
  },
  badge: (color) => ({
    fontSize: '9px', fontFamily: 'monospace', padding: '2px 7px',
    borderRadius: '3px', letterSpacing: '.5px', textTransform: 'uppercase',
    background: `${color}18`, color, border: `1px solid ${color}44`,
  }),
};

