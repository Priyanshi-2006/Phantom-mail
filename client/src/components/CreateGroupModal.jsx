import { useState, useEffect } from 'react';
import api from '../utils/api';
import { generateGroupKey, encryptGroupKey } from '../utils/crypto';

export default function CreateGroupModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [aliasInput, setAliasInput] = useState('');
  const [members, setMembers] = useState([]); // array of aliases
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lookupError, setLookupError] = useState('');

  const MAX_GROUP_MEMBERS = 50;

  // Debounced lookup of alias status
  useEffect(() => {
    const aliasTrimmed = aliasInput.trim();
    if (!aliasTrimmed || !aliasTrimmed.includes('-')) {
      Promise.resolve().then(() => {
        setLookupError('');
      });
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await api.get(`/keys/resolve/${aliasTrimmed}`);
        if (!res.data.exists) {
          setLookupError('Recipient not found');
        } else {
          setLookupError('');
        }
      } catch {
        setLookupError('Recipient not found');
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [aliasInput]);

  const addMember = async () => {
    const alias = aliasInput.trim();
    if (!alias) return;

    if (members.includes(alias)) {
      setLookupError('Already added');
      return;
    }

    if (members.length + 1 >= MAX_GROUP_MEMBERS) {
      setLookupError(`Max ${MAX_GROUP_MEMBERS} members (including yourself)`);
      return;
    }

    try {
      const res = await api.get(`/keys/resolve/${alias}`);
      if (!res.data.exists) {
        setLookupError('Recipient not found');
        return;
      }
      setMembers([...members, alias]);
      setAliasInput('');
      setLookupError('');
    } catch {
      setLookupError('Recipient not found');
    }
  };

  const removeMember = (index) => {
    setMembers(members.filter((_, i) => i !== index));
  };

  const createGroup = async () => {
    if (!name.trim()) {
      setError('Group name is required');
      return;
    }
    if (members.length === 0) {
      setError('Add at least one member');
      return;
    }

    setError('');
    setBusy(true);

    try {
      setStatus('Generating group key...');
      const groupKey = await generateGroupKey();

      setStatus(`Encrypting key for ${members.length + 1} members...`);
      const encryptedKeys = {};

      // Encrypt for self
      const meRes = await api.get('/auth/me');
      const myPubKey = meRes.data.public_key;
      encryptedKeys[meRes.data.alias] = await encryptGroupKey(groupKey, myPubKey);

      // Encrypt for each member
      for (const alias of members) {
        const res = await api.get(`/keys/${alias}`);
        const pubKey = res.data.public_key;
        encryptedKeys[alias] = await encryptGroupKey(groupKey, pubKey);
      }

      setStatus('Creating group...');
      await api.post('/groups/create', {
        name: name.trim(),
        members,
        encrypted_keys: encryptedKeys
      });

      setStatus('✓ Group created');
      setTimeout(() => {
        onCreated();
        onClose();
      }, 700);

    } catch (err) {
      setError(err.message || err.response?.data?.error || 'Failed to create group');
      setBusy(false);
      setStatus('');
    }
  };

  return (
    <div style={s.backdrop}>
      <div style={s.modal}>
        <div style={s.header}>
          <span style={s.title}>New Encrypted Group</span>
          <button style={s.closeBtn} onClick={onClose} disabled={busy}>×</button>
        </div>

        <div style={s.field}>
          <label style={s.label}>Name</label>
          <input 
            style={s.fieldInput} 
            value={name} 
            onChange={(e) => setName(e.target.value)}
            placeholder="Group name" 
            autoFocus 
            disabled={busy}
          />
        </div>

        <div style={s.field}>
          <label style={s.label}>Members</label>
          <div style={{ flex: 1, display: 'flex', gap: '8px' }}>
            <input 
              style={s.fieldInput} 
              value={aliasInput} 
              onChange={(e) => setAliasInput(e.target.value)}
              placeholder="alias (e.g. ghost-7f3a2b)" 
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addMember();
                }
              }}
            />
            <button 
              style={s.addBtn} 
              onClick={addMember}
              disabled={busy || !aliasInput.trim()}
            >
              Add
            </button>
          </div>
          {lookupError && (
            <span style={{ fontSize: '11px', color: '#ff8888', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
              ⚠ {lookupError}
            </span>
          )}
        </div>

        {members.length > 0 && (
          <div style={s.membersBox}>
            {members.map((alias, i) => (
              <div key={i} style={s.memberPill}>
                <span style={s.memberName}>{alias}</span>
                <button style={s.memberRemove} onClick={() => removeMember(i)} disabled={busy}>×</button>
              </div>
            ))}
          </div>
        )}

        <div style={s.footer}>
          {status && <span style={s.statusText}>{status}</span>}
          {error && <span style={s.errorText}>{error}</span>}
          <button 
            style={{ ...s.createBtn, opacity: busy ? 0.7 : 1 }}
            onClick={createGroup} 
            disabled={busy || !name.trim() || members.length === 0}
          >
            {busy ? '…' : '🔒 Create Group'}
          </button>
        </div>

        <div style={s.badgeRow}>
          <span style={s.badge('#00e5a0')}>E2E Encrypted</span>
          <span style={s.badge('#0066ff')}>AES-256</span>
          <span style={{ marginLeft: 'auto', fontSize: '10px', color: '#4a5568', fontFamily: 'monospace' }}>
            Group key is wrapped per member with RSA
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
    width: '440px', maxWidth: '95vw', display: 'flex', flexDirection: 'column',
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
  addBtn: {
    background: '#1e2330', border: '1px solid #232839', color: '#e8eaf0',
    borderRadius: '4px', padding: '4px 10px', fontSize: '11px', cursor: 'pointer'
  },
  membersBox: {
    margin: '12px 16px', padding: '8px', background: 'rgba(0,0,0,0.2)',
    borderRadius: '6px', border: '1px solid #232839', display: 'flex', flexWrap: 'wrap', gap: '6px',
    maxHeight: '150px', overflowY: 'auto'
  },
  memberPill: {
    display: 'flex', alignItems: 'center', gap: '6px', background: '#111318',
    padding: '4px 8px', borderRadius: '4px', border: '1px solid #232839'
  },
  memberName: { fontSize: '11px', color: '#8892a4', fontFamily: 'monospace' },
  memberRemove: { background: 'none', border: 'none', color: '#ff8888', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '0 2px' },
  footer: {
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '11px 16px', borderTop: '1px solid #232839', justifyContent: 'flex-end',
  },
  createBtn: {
    background: '#00e5a0', color: '#000', border: 'none', borderRadius: '6px',
    padding: '9px 18px', fontWeight: '700', fontSize: '13px', cursor: 'pointer',
    fontFamily: 'inherit',
  },
  statusText: { fontSize: '11px', color: '#00e5a0', fontFamily: 'monospace', marginRight: 'auto' },
  errorText:  { fontSize: '11px', color: '#ff8888', marginRight: 'auto' },
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
