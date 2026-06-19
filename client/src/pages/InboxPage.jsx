import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { 
  decryptMessage, 
  loadPrivateKey,
  exportKeystore,
  importKeystore,
  generateKeyPair,
  savePrivateKey
} from '../utils/crypto';
import { getSocket } from '../utils/socket';
import ComposeModal from '../components/ComposeModal';
import api from '../utils/api';

// ── Tiny helper components ─────────────────────────────────────

function Tag({ color, label }) {
  return (
    <span style={{
      fontSize: '9px', fontFamily: 'monospace', padding: '1px 6px',
      borderRadius: '3px', letterSpacing: '.5px', textTransform: 'uppercase',
      background: `${color}18`, color, border: `1px solid ${color}44`,
    }}>
      {label}
    </span>
  );
}

function ShieldRow({ dot, label, value, valueColor = '#00e5a0' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', marginBottom: '5px' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, display: 'inline-block', flexShrink: 0 }} />
      <span style={{ flex: 1, color: '#8892a4' }}>{label}</span>
      <span style={{ fontFamily: 'monospace', fontSize: '10px', color: valueColor }}>{value}</span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────

export default function InboxPage() {
  const { user, logout, socketConnected }  = useAuth();
  const [messages, setMessages]   = useState([]);
  const [selected, setSelected]   = useState(null);
  const [decrypted, setDecrypted] = useState({ subject: '', body: '' });
  const [loading,   setLoading]   = useState(true);
  const [decrypting, setDecrypting] = useState(false);
  const [compose,   setCompose]   = useState(false);
  const [activeNav, setActiveNav] = useState('inbox');
  const [copied,    setCopied]    = useState(false);
  const [senderPresence, setSenderPresence] = useState({ online: false, lastSeen: null, loading: false });

  // Keyring & settings states
  const [passphraseExport, setPassphraseExport] = useState('');
  const [passphraseImport, setPassphraseImport] = useState('');
  const [importFile, setImportFile] = useState(null);
  const [keyringStatus, setKeyringStatus] = useState('');
  const [keyringError, setKeyringError] = useState('');
  const [allowReceipts, setAllowReceipts] = useState(user?.allow_read_receipts ?? 1);

  // ── Data fetching ──────────────────────────────────────────

  const fetchMessages = useCallback(async () => {
    setLoading(true);
    try {
      if (activeNav === 'inbox') {
        const res = await api.get('/messages/inbox');
        setMessages(res.data);
      } else if (activeNav === 'sent') {
        const res = await api.get('/messages/sent/list');
        setMessages(res.data);
      } else if (activeNav === 'ephemeral') {
        const res = await api.get('/messages/inbox');
        setMessages(res.data.filter(m => m.is_ephemeral));
      }
    } catch (e) {
      console.error('Fetch messages error:', e);
    } finally {
      setLoading(false);
    }
  }, [activeNav]);

  useEffect(() => {
    Promise.resolve().then(() => {
      if (activeNav !== 'keyring') {
        fetchMessages();
      }
    });
  }, [fetchMessages, activeNav]);

  // Sync settings when entering keyring
  useEffect(() => {
    if (activeNav === 'keyring') {
      api.get('/auth/me')
        .then(res => {
          setAllowReceipts(res.data.allow_read_receipts ?? 1);
          const savedUser = JSON.parse(localStorage.getItem('pm_user') || '{}');
          savedUser.allow_read_receipts = res.data.allow_read_receipts;
          localStorage.setItem('pm_user', JSON.stringify(savedUser));
        })
        .catch(err => console.error('Error syncing settings:', err));
    }
  }, [activeNav]);

  // Listen for real-time WebSocket events when socket is connected
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleNewMessage = (msg) => {
      setMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
        if (activeNav === 'inbox' || (activeNav === 'ephemeral' && msg.is_ephemeral)) {
          return [msg, ...prev];
        }
        return prev;
      });
    };

    socket.on('new_message', handleNewMessage);
    return () => {
      socket.off('new_message', handleNewMessage);
    };
  }, [socketConnected, activeNav]);

  // Poll for new messages every 15 seconds ONLY as a fallback if WebSocket is disconnected
  useEffect(() => {
    if (socketConnected || activeNav === 'keyring') return;

    const interval = setInterval(fetchMessages, 15000);
    return () => clearInterval(interval);
  }, [fetchMessages, socketConnected, activeNav]);

  // ── Actions ────────────────────────────────────────────────

  const openMessage = async (msg) => {
    setSelected(msg);
    setDecrypted({ subject: '', body: '' });

    if (activeNav === 'sent') {
      setDecrypted({
        subject: '🔒 Encrypted message payload',
        body: 'This message was encrypted with the recipient\'s public key before leaving your browser.\n\nTo preserve zero-knowledge privacy, only the recipient possesses the private key required to decrypt this message. The ciphertext remains secure on the relay node.',
      });
      setDecrypting(false);
      setSenderPresence({ online: false, lastSeen: null, loading: false });
      return;
    }

    setDecrypting(true);
    setSenderPresence({ online: false, lastSeen: null, loading: true });

    // Fetch sender presence on-demand
    api.get(`/keys/presence/${msg.sender_alias}`)
      .then(res => {
        setSenderPresence({
          online: res.data.online,
          lastSeen: res.data.last_seen,
          loading: false,
        });
      })
      .catch(() => {
        setSenderPresence({ online: false, lastSeen: null, loading: false });
      });

    try {
      const full = await api.get(`/messages/${msg.id}`);
      const pk   = loadPrivateKey();

      if (!pk) {
        setDecrypted({
          subject: '⚠ Private key not found',
          body: 'Your private key is missing from this browser session. This happens if you logged in on a different device or cleared your browser data. Private keys are device-local by design.',
        });
        return;
      }

      const subject = await decryptMessage(full.data.subject_encrypted, pk);
      const body    = await decryptMessage(full.data.body_encrypted, pk);
      setDecrypted({ subject, body });

      // Mark as read locally
      setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, is_read: 1 } : m));

    } catch {
      setDecrypted({
        subject: '⚠ Decryption failed',
        body: 'Could not decrypt this message. This may happen if the sender used an old public key before you regenerated your keys.',
      });
    } finally {
      setDecrypting(false);
    }
  };

  const deleteMessage = async (id) => {
    await api.delete(`/messages/${id}`);
    setMessages(prev => prev.filter(m => m.id !== id));
    setSelected(null);
  };

  // ── Keyring & settings handlers ──────────────────────────────────

  const handleExport = async () => {
    if (!passphraseExport) return;
    setKeyringStatus('Encrypting keys...');
    setKeyringError('');
    try {
      const pk = loadPrivateKey();
      if (!pk) throw new Error('No local private key found to export.');

      const backupJson = await exportKeystore(pk, user.public_key, user.alias, passphraseExport);

      const blob = new Blob([backupJson], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `phantommail_backup_${user.alias}.json`;
      a.click();
      URL.revokeObjectURL(url);

      setKeyringStatus('✓ Keystore exported successfully.');
      setPassphraseExport('');
    } catch (err) {
      setKeyringError(err.message || 'Export failed.');
      setKeyringStatus('');
    }
  };

  const handleImport = async () => {
    if (!importFile || !passphraseImport) return;
    setKeyringStatus('Decrypting keys...');
    setKeyringError('');
    try {
      const text = await importFile.text();
      const privateKey = await importKeystore(text, passphraseImport);

      savePrivateKey(privateKey);

      setKeyringStatus('✓ Keystore imported and loaded successfully.');
      setPassphraseImport('');
      setImportFile(null);

      const fileInput = document.getElementById('keystore-file-input');
      if (fileInput) fileInput.value = '';
    } catch (err) {
      setKeyringError(err.message || 'Import failed.');
      setKeyringStatus('');
    }
  };

  const handleRegenerate = async () => {
    if (!window.confirm('WARNING: Regenerating your key pair will replace your existing local keys. If you have old encrypted messages and have not backed up your keys, you will lose access to them forever. Do you want to continue?')) return;
    setKeyringStatus('Generating new keys...');
    setKeyringError('');
    try {
      const keys = await generateKeyPair();

      await api.post('/keys/upload', { public_key: keys.publicKey });
      savePrivateKey(keys.privateKey);

      setKeyringStatus('✓ New key pair generated and published successfully.');
    } catch (err) {
      setKeyringError(err.message || 'Key generation failed.');
      setKeyringStatus('');
    }
  };

  const handleToggleReceipts = async (checked) => {
    setAllowReceipts(checked ? 1 : 0);
    try {
      await api.post('/auth/settings', { allow_read_receipts: checked });
      const savedUser = JSON.parse(localStorage.getItem('pm_user') || '{}');
      savedUser.allow_read_receipts = checked ? 1 : 0;
      localStorage.setItem('pm_user', JSON.stringify(savedUser));
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  };

  const renderKeyRingPanel = () => {
    const pkExists = !!loadPrivateKey();
    return (
      <div style={{ flex: 1, display: 'flex', gap: '20px', padding: '24px', overflowY: 'auto', background: '#0a0b0e' }}>
        
        {/* Left Column: Key Status */}
        <div style={{ flex: 1, background: '#111318', border: '1px solid #232839', borderRadius: '12px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: '600', borderBottom: '1px solid #232839', paddingBottom: '10px', color: '#00e5a0', fontFamily: 'monospace' }}>
            🔑 Keys & Identity
          </h3>
          
          <div>
            <div style={{ fontSize: '11px', color: '#4a5568', fontFamily: 'monospace', textTransform: 'uppercase', marginBottom: '4px' }}>My Alias</div>
            <div style={{ fontSize: '13px', color: '#00e5a0', fontFamily: 'monospace' }}>{user?.alias}</div>
          </div>
          
          <div>
            <div style={{ fontSize: '11px', color: '#4a5568', fontFamily: 'monospace', textTransform: 'uppercase', marginBottom: '4px' }}>Public Key</div>
            <div style={{ fontSize: '10px', color: '#8892a4', fontFamily: 'monospace', wordBreak: 'break-all', background: '#171b22', padding: '8px', borderRadius: '6px', border: '1px solid #232839', maxHeight: '100px', overflowY: 'auto' }}>
              {user?.public_key || 'No public key uploaded'}
            </div>
          </div>
          
          <div>
            <div style={{ fontSize: '11px', color: '#4a5568', fontFamily: 'monospace', textTransform: 'uppercase', marginBottom: '4px' }}>Private Key Status</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: pkExists ? '#00e5a0' : '#ff8888' }} />
              <span style={{ color: pkExists ? '#e8eaf0' : '#ff8888', fontWeight: '600' }}>
                {pkExists ? 'Stored locally in browser' : 'MISSING! You cannot decrypt incoming messages.'}
              </span>
            </div>
          </div>

          <div style={{ marginTop: 'auto', borderTop: '1px solid #232839', paddingTop: '16px' }}>
            <button 
              onClick={handleRegenerate}
              style={{ background: 'rgba(255,136,136,0.1)', border: '1px solid rgba(255,136,136,0.3)', color: '#ff8888', padding: '10px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: '600' }}
            >
              🔄 Regenerate Key Pair
            </button>
          </div>
        </div>

        {/* Right Column: Backup & Restore */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {/* Export Keystore */}
          <div style={{ background: '#111318', border: '1px solid #232839', borderRadius: '12px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#e8eaf0' }}>📥 Export Keystore Backup</h3>
            <p style={{ fontSize: '12px', color: '#8892a4', lineHeight: '1.5' }}>
              Download a passphrase-encrypted file of your key pair. Keep this file safe. You will need it to login from other devices.
            </p>
            <input 
              type="password"
              placeholder="Enter encryption passphrase (min 8 chars)"
              value={passphraseExport}
              onChange={(e) => setPassphraseExport(e.target.value)}
              style={{ background: '#171b22', border: '1px solid #232839', color: '#e8eaf0', padding: '10px', borderRadius: '6px', fontSize: '12px', outline: 'none' }}
            />
            <button 
              disabled={passphraseExport.length < 8}
              onClick={handleExport}
              style={{ background: '#00e5a0', color: '#000', border: 'none', padding: '10px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: '700', cursor: 'pointer', opacity: passphraseExport.length < 8 ? 0.6 : 1 }}
            >
              🔐 Export & Download
            </button>
          </div>

          {/* Import Keystore */}
          <div style={{ background: '#111318', border: '1px solid #232839', borderRadius: '12px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#e8eaf0' }}>📤 Import Keystore Backup</h3>
            <p style={{ fontSize: '12px', color: '#8892a4', lineHeight: '1.5' }}>
              Upload your encrypted backup file and enter the passphrase to restore your private key.
            </p>
            <input 
              id="keystore-file-input"
              type="file"
              accept=".json"
              onChange={(e) => setImportFile(e.target.files[0])}
              style={{ fontSize: '12px', color: '#8892a4' }}
            />
            <input 
              type="password"
              placeholder="Enter backup passphrase"
              value={passphraseImport}
              onChange={(e) => setPassphraseImport(e.target.value)}
              style={{ background: '#171b22', border: '1px solid #232839', color: '#e8eaf0', padding: '10px', borderRadius: '6px', fontSize: '12px', outline: 'none' }}
            />
            <button 
              disabled={!importFile || !passphraseImport}
              onClick={handleImport}
              style={{ background: 'rgba(0,229,160,0.1)', border: '1px solid rgba(0,229,160,0.3)', color: '#00e5a0', padding: '10px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer', opacity: (!importFile || !passphraseImport) ? 0.6 : 1 }}
            >
              🔓 Decrypt & Import
            </button>
          </div>

          {/* Privacy Settings */}
          <div style={{ background: '#111318', border: '1px solid #232839', borderRadius: '12px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#e8eaf0' }}>⚙️ Privacy Settings</h3>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#e8eaf0', cursor: 'pointer' }}>
              <input 
                type="checkbox"
                checked={allowReceipts === 1}
                onChange={(e) => handleToggleReceipts(e.target.checked)}
              />
              Send read receipts (optional)
            </label>
            <p style={{ fontSize: '11px', color: '#4a5568', lineHeight: '1.4' }}>
              If disabled, other users will not see when you read/decrypt their messages.
            </p>
          </div>

          {/* Feedback messages */}
          {keyringStatus && <div style={{ color: '#00e5a0', fontSize: '12px', fontFamily: 'monospace' }}>{keyringStatus}</div>}
          {keyringError && <div style={{ color: '#ff8888', fontSize: '12px', fontFamily: 'monospace' }}>{keyringError}</div>}

        </div>

      </div>
    );
  };

  const copyAlias = () => {
    navigator.clipboard.writeText(user.alias);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Helpers ────────────────────────────────────────────────

  const formatTime = (ts) => {
    // eslint-disable-next-line react-hooks/purity
    const diff = Date.now() - ts;
    if (diff < 60000)    return 'just now';
    if (diff < 3600000)  return `~${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `~${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  const unread = messages.filter(m => !m.is_read).length;

  // ── Render ─────────────────────────────────────────────────

  return (
    <div style={s.shell}>

      {/* ── TOP BAR ── */}
      <div style={s.topbar}>
        <div style={s.logo}>phantom<span style={{ color: '#4a5568' }}>mail</span></div>
        <div style={s.shieldBadge}>E2E + METADATA SHIELD</div>

        <div style={s.searchBar}>
          <span style={{ color: '#4a5568' }}>⌕</span>
          <input style={s.searchInput} placeholder="Search (coming soon)" readOnly />
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginLeft: 'auto' }}>
          <span
            style={s.aliasBadge}
            onClick={copyAlias}
            title="Click to copy your alias — share this with people who want to message you"
          >
            {copied ? '✓ Copied!' : `👤 ${user?.alias}`}
          </span>
          <button style={s.iconBtn} onClick={logout} title="Sign out">⏻</button>
        </div>
      </div>

      {/* ── MAIN LAYOUT ── */}
      {/* ── MAIN LAYOUT ── */}
      <div style={s.main}>

        {/* Sidebar */}
        <div style={s.sidebar}>
          <button style={s.composeBtn} onClick={() => setCompose(true)}>
            ✏ &nbsp;Compose
          </button>

          {[
            { id: 'inbox',     icon: '📥', label: 'Inbox',    count: unread },
            { id: 'sent',      icon: '📤', label: 'Sent' },
            { id: 'ephemeral', icon: '🔥', label: 'Ephemeral' },
            { id: 'keyring',   icon: '🔑', label: 'Key Ring' },
          ].map(item => (
            <div
              key={item.id}
              style={{ ...s.navItem, ...(activeNav === item.id ? s.navActive : {}) }}
              onClick={() => { setActiveNav(item.id); setSelected(null); }}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
              {item.id === 'inbox' && item.count > 0 && <span style={s.navBadge}>{item.count}</span>}
            </div>
          ))}

          <div style={s.divider} />
          <div style={s.sideLabel}>Privacy</div>
          <div style={s.navItem}><span>🧅</span><span>Onion Routed</span></div>
          <div style={s.navItem}><span>👻</span><span>Anonymous</span></div>

          {/* Alias card at bottom of sidebar */}
          <div style={{ marginTop: 'auto', padding: '12px 10px' }}>
            <div style={s.aliasCard}>
              <div style={{ fontSize: '10px', color: '#4a5568', fontFamily: 'monospace', marginBottom: '6px', letterSpacing: '1px', textTransform: 'uppercase' }}>Your Alias</div>
              <div style={{ fontSize: '11px', color: '#00e5a0', fontFamily: 'monospace', wordBreak: 'break-all', marginBottom: '8px' }}>{user?.alias}</div>
              <button style={s.copyBtn} onClick={copyAlias}>
                {copied ? '✓ Copied' : 'Copy to share'}
              </button>
            </div>
          </div>
        </div>

        {activeNav === 'keyring' ? (
          renderKeyRingPanel()
        ) : (
          <>
            {/* Message list */}
            <div style={s.inboxPanel}>
              <div style={s.inboxHeader}>
                <span style={{ fontSize: '15px', fontWeight: '600' }}>
                  {activeNav === 'inbox' && 'Inbox'}
                  {activeNav === 'sent' && 'Sent Messages'}
                  {activeNav === 'ephemeral' && 'Ephemeral Inbox'}
                </span>
                <span style={{ fontSize: '11px', color: '#4a5568', fontFamily: 'monospace' }}>
                  {messages.length} messages {activeNav === 'inbox' && `· ${unread} unread`}
                </span>
              </div>

              <div style={s.privacyBanner}>
                <span style={s.pDot} />
                Metadata shield active · IP masked · Timestamps obfuscated ±2h · Zero server logging
              </div>

              <div style={s.msgList}>
                {loading && <div style={s.empty}>Loading messages…</div>}

                {!loading && messages.length === 0 && (
                  <div style={s.empty}>
                    <div style={{ fontSize: '36px', marginBottom: '14px' }}>📭</div>
                    <strong style={{ color: '#e8eaf0' }}>No messages yet</strong>
                    <p style={{ marginTop: '8px' }}>Share your alias so people can message you:</p>
                    <span
                      style={{ color: '#00e5a0', fontFamily: 'monospace', fontSize: '13px', cursor: 'pointer', marginTop: '6px', display: 'block' }}
                      onClick={copyAlias}
                    >
                      {user?.alias}
                    </span>
                    <p style={{ marginTop: '4px', fontSize: '11px' }}>(click to copy)</p>
                  </div>
                )}

                {messages.map(msg => (
                  <div
                    key={msg.id}
                    style={{
                      ...s.msgItem,
                      ...((activeNav !== 'sent' && !msg.is_read) ? s.msgUnread : {}),
                      ...(selected?.id === msg.id ? s.msgSelected : {}),
                    }}
                    onClick={() => openMessage(msg)}
                  >
                    <div style={{ ...s.msgAvatar, background: 'linear-gradient(135deg,#00e5a0,#0066ff)' }}>?</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '3px' }}>
                        <span style={{ fontSize: '13px', fontWeight: (activeNav !== 'sent' && !msg.is_read) ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {activeNav === 'sent' ? `To: ${msg.recipient_alias}` : msg.sender_alias}
                        </span>
                        <span style={{ marginLeft: 'auto', fontSize: '10px', color: '#4a5568', fontFamily: 'monospace', paddingLeft: '8px', whiteSpace: 'nowrap' }}>
                          {formatTime(msg.approximate_time)}
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>🔒 Encrypted message</div>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        <Tag color="#00e5a0" label="E2E" />
                        <Tag color="#6a9fff" label={`${msg.routing_hops} hops`} />
                        {msg.is_ephemeral ? <Tag color="#ff8888" label="ephemeral" /> : null}
                        {activeNav === 'sent' && (
                          <Tag 
                            color={msg.is_read ? "#00e5a0" : "#8892a4"} 
                            label={msg.is_read ? "read" : "sent"} 
                          />
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Detail panel */}
        <div style={s.detail}>
          {!selected ? (
            <div style={s.detailEmpty}>
              <div style={{ fontSize: '44px', marginBottom: '14px' }}>🔒</div>
              <div style={{ color: '#4a5568', fontSize: '13px', textAlign: 'center', lineHeight: '1.8' }}>
                Select a message to decrypt and read it.
                <br />
                <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                  Decryption happens entirely in your browser.
                </span>
              </div>
            </div>
          ) : (
            <>
              {/* Detail header */}
              <div style={s.detailHeader}>
                <div style={{ fontSize: '15px', fontWeight: '600', marginBottom: '12px', lineHeight: '1.4' }}>
                  {decrypting ? (
                    <span style={{ color: '#4a5568', fontFamily: 'monospace', fontSize: '12px' }}>🔓 Decrypting with your private key…</span>
                  ) : (
                    decrypted.subject || '…'
                  )}
                </div>
                <div style={{ fontSize: '11px', color: '#8892a4', marginBottom: '4px' }}>
                  <span style={{ color: '#4a5568', fontFamily: 'monospace', marginRight: '8px' }}>From</span>
                  <span style={s.anonBadge}>{selected.sender_alias}</span>
                </div>
                <div style={{ fontSize: '11px', color: '#4a5568', fontFamily: 'monospace' }}>
                  <span style={{ marginRight: '8px' }}>Time</span>
                  ± 2h window · exact timestamp hidden
                </div>
              </div>

              {/* Privacy shield */}
              <div style={s.shieldBox}>
                <div style={{ fontSize: '10px', fontFamily: 'monospace', color: '#4a5568', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '10px' }}>
                  Privacy Shield Status
                </div>
                <ShieldRow dot="#00e5a0" label="End-to-end encryption" value="AES-256-GCM" />
                <ShieldRow dot="#0066ff" label="Metadata anonymized"   value="ACTIVE"     valueColor="#6a9fff" />
                <ShieldRow dot="#00e5a0" label="Routing hops"          value={`${selected.routing_hops} hops`} />
                <ShieldRow dot="#ffc800" label="Timestamp obfuscation" value="±2h noise"  valueColor="#ffc800" />
                <ShieldRow dot="#00e5a0" label="Sender IP logged"      value="NEVER" />
                <ShieldRow
                  dot={senderPresence.loading ? "#8892a4" : (senderPresence.online ? "#00e5a0" : "#ff8888")}
                  label="Sender presence"
                  value={
                    senderPresence.loading
                      ? "checking..."
                      : senderPresence.online
                      ? "online"
                      : senderPresence.lastSeen
                      ? `offline (seen ${formatTime(senderPresence.lastSeen)})`
                      : "offline"
                  }
                  valueColor={senderPresence.online ? "#00e5a0" : "#8892a4"}
                />
              </div>

              {/* Message body */}
              <div style={s.detailBody}>
                {decrypting ? (
                  <div style={{ color: '#4a5568', fontFamily: 'monospace', fontSize: '12px' }}>
                    Unlocking with RSA-OAEP private key…
                  </div>
                ) : (
                  <div style={{ fontSize: '13px', lineHeight: '1.8', color: '#e8eaf0', whiteSpace: 'pre-wrap' }}>
                    {decrypted.body}
                  </div>
                )}
              </div>

              {/* Footer actions */}
              <div style={s.detailFooter}>
                <button style={s.replyBtn} onClick={() => setCompose(true)}>↩ Reply</button>
                <button style={s.actionBtn} onClick={() => deleteMessage(selected.id)}>🗑 Delete</button>
              </div>
            </>
          )}
        </div>

      </div>{/* end .main */}

      {/* ── STATUS BAR ── */}
      <div style={s.statusbar}>
        <span>
          <span style={{
            ...s.pulse,
            background: socketConnected ? '#00e5a0' : '#ff8888',
            boxShadow: socketConnected ? '0 0 8px #00e5a0' : '0 0 8px #ff8888',
            animation: socketConnected ? 'pulse 2s infinite' : 'none',
          }} />
          {socketConnected ? 'Connected' : 'Disconnected'}
        </span>
        <span>· Alias: <span style={{ color: '#00e5a0' }}>{user?.alias}</span></span>
        <span>· All messages E2E encrypted</span>
        <span style={{ marginLeft: 'auto' }}>PhantomMail v1.0.0</span>
      </div>

      {/* Compose modal */}
      {compose && <ComposeModal onClose={() => setCompose(false)} onSent={fetchMessages} />}

    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────

const s = {
  shell: {
    height: '100vh', display: 'flex', flexDirection: 'column',
    background: '#0a0b0e', color: '#e8eaf0',
    fontFamily: "'IBM Plex Sans', sans-serif", overflow: 'hidden',
  },
  topbar: {
    display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 20px',
    background: '#111318', borderBottom: '1px solid #232839', flexShrink: 0,
  },
  logo: { fontFamily: "'IBM Plex Mono', monospace", fontSize: '18px', fontWeight: '700', color: '#00e5a0' },
  shieldBadge: {
    fontFamily: 'monospace', fontSize: '9px', letterSpacing: '1px',
    background: 'rgba(0,229,160,.08)', border: '1px solid rgba(0,229,160,.25)',
    color: '#00e5a0', padding: '2px 8px', borderRadius: '3px',
  },
  searchBar: {
    flex: 1, maxWidth: '420px', margin: '0 auto', background: '#171b22',
    border: '1px solid #232839', borderRadius: '6px',
    display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 12px',
  },
  searchInput: {
    background: 'none', border: 'none', outline: 'none',
    color: '#e8eaf0', fontFamily: 'inherit', fontSize: '13px', flex: 1,
  },
  aliasBadge: {
    fontFamily: 'monospace', fontSize: '11px', background: 'rgba(0,229,160,.08)',
    border: '1px solid rgba(0,229,160,.2)', color: '#00e5a0',
    padding: '4px 10px', borderRadius: '4px', cursor: 'pointer',
  },
  iconBtn: { background: 'none', border: 'none', color: '#8892a4', cursor: 'pointer', fontSize: '17px', padding: '4px 6px', borderRadius: '4px' },
  main: { display: 'flex', flex: 1, overflow: 'hidden' },

  // Sidebar
  sidebar: {
    width: '200px', flexShrink: 0, background: '#111318',
    borderRight: '1px solid #232839', display: 'flex', flexDirection: 'column',
    padding: '14px 10px', gap: '3px', overflowY: 'auto',
  },
  composeBtn: {
    background: '#00e5a0', color: '#000', border: 'none', borderRadius: '7px',
    padding: '10px 14px', fontFamily: 'inherit', fontWeight: '700',
    fontSize: '13px', cursor: 'pointer', marginBottom: '8px', textAlign: 'left',
  },
  navItem: {
    display: 'flex', alignItems: 'center', gap: '9px', padding: '7px 10px',
    borderRadius: '5px', fontSize: '13px', color: '#8892a4', cursor: 'pointer',
    transition: 'all .12s',
  },
  navActive: { background: 'rgba(0,229,160,.1)', color: '#00e5a0' },
  navBadge: {
    marginLeft: 'auto', background: '#0066ff', color: '#fff',
    fontSize: '10px', fontFamily: 'monospace', padding: '1px 6px', borderRadius: '10px',
  },
  divider: { height: '1px', background: '#232839', margin: '8px 4px' },
  sideLabel: {
    fontSize: '10px', color: '#4a5568', fontFamily: 'monospace',
    letterSpacing: '1px', padding: '2px 10px', textTransform: 'uppercase',
  },
  aliasCard: {
    background: '#171b22', border: '1px solid #232839', borderRadius: '7px', padding: '10px 12px',
  },
  copyBtn: {
    width: '100%', background: 'rgba(0,229,160,.1)', border: '1px solid rgba(0,229,160,.2)',
    color: '#00e5a0', borderRadius: '4px', padding: '5px', fontSize: '11px',
    cursor: 'pointer', fontFamily: 'monospace',
  },

  // Inbox panel
  inboxPanel: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  inboxHeader: {
    padding: '12px 18px', borderBottom: '1px solid #232839',
    display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0,
  },
  privacyBanner: {
    margin: '10px 14px 0', padding: '7px 12px', flexShrink: 0,
    background: 'rgba(0,102,255,.06)', border: '1px solid rgba(0,102,255,.18)',
    borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '8px',
    fontSize: '10px', color: '#6a9fff', fontFamily: 'monospace',
  },
  pDot: { display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#0066ff', flexShrink: 0 },
  msgList: { flex: 1, overflowY: 'auto', padding: '6px 0' },
  empty: { textAlign: 'center', color: '#4a5568', fontSize: '13px', padding: '60px 20px', lineHeight: '1.9' },
  msgItem: {
    display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 14px',
    borderBottom: '1px solid rgba(35,40,57,.5)', cursor: 'pointer', transition: 'background .1s',
  },
  msgUnread: { background: 'rgba(0,229,160,.025)', borderLeft: '3px solid #00e5a0' },
  msgSelected: { background: '#1e2330' },
  msgAvatar: {
    width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', color: '#000',
  },

  // Detail panel
  detail: {
    width: '430px', flexShrink: 0, borderLeft: '1px solid #232839',
    background: '#111318', display: 'flex', flexDirection: 'column', overflow: 'hidden',
  },
  detailEmpty: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: '30px',
  },
  detailHeader: { padding: '16px 18px', borderBottom: '1px solid #232839', flexShrink: 0 },
  anonBadge: {
    color: '#00e5a0', fontFamily: 'monospace', fontSize: '11px',
    background: 'rgba(0,229,160,.08)', border: '1px solid rgba(0,229,160,.2)',
    padding: '1px 7px', borderRadius: '3px',
  },
  shieldBox: {
    margin: '12px 16px', padding: '12px 14px', background: '#171b22',
    border: '1px solid #232839', borderRadius: '8px', flexShrink: 0,
  },
  detailBody: { flex: 1, overflowY: 'auto', padding: '16px 18px' },
  detailFooter: {
    padding: '12px 16px', borderTop: '1px solid #232839',
    display: 'flex', gap: '8px', flexShrink: 0,
  },
  replyBtn: {
    flex: 1, background: '#00e5a0', color: '#000', border: 'none',
    borderRadius: '6px', padding: '10px', fontWeight: '700', fontSize: '13px',
    cursor: 'pointer', fontFamily: 'inherit',
  },
  actionBtn: {
    background: '#171b22', border: '1px solid #232839', color: '#8892a4',
    borderRadius: '6px', padding: '10px 14px', fontSize: '13px', cursor: 'pointer',
  },

  // Status bar
  statusbar: {
    display: 'flex', alignItems: 'center', gap: '14px', padding: '5px 16px',
    background: '#111318', borderTop: '1px solid #232839',
    fontSize: '10px', fontFamily: 'monospace', color: '#4a5568', flexShrink: 0,
  },
  pulse: {
    display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
    background: '#00e5a0', marginRight: '5px',
    animation: 'pulse 2s infinite',
  },
};
