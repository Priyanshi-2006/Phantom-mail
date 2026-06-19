import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { decryptMessage, loadPrivateKey } from '../utils/crypto';
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

  // ── Data fetching ──────────────────────────────────────────

  const fetchInbox = useCallback(async () => {
    try {
      const res = await api.get('/messages/inbox');
      setMessages(res.data);
    } catch (e) {
      console.error('Inbox fetch error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    Promise.resolve().then(() => {
      fetchInbox();
    });
  }, [fetchInbox]);

  // Listen for real-time WebSocket events when socket is connected
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleNewMessage = (msg) => {
      setMessages(prev => {
        // Prevent duplicate messages if any
        if (prev.some(m => m.id === msg.id)) return prev;
        return [msg, ...prev];
      });
    };

    socket.on('new_message', handleNewMessage);
    return () => {
      socket.off('new_message', handleNewMessage);
    };
  }, [socketConnected]);

  // Poll for new messages every 15 seconds ONLY as a fallback if WebSocket is disconnected
  useEffect(() => {
    if (socketConnected) return;

    const interval = setInterval(fetchInbox, 15000);
    return () => clearInterval(interval);
  }, [fetchInbox, socketConnected]);

  // ── Actions ────────────────────────────────────────────────

  const openMessage = async (msg) => {
    setSelected(msg);
    setDecrypted({ subject: '', body: '' });
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
              onClick={() => setActiveNav(item.id)}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
              {item.count > 0 && <span style={s.navBadge}>{item.count}</span>}
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

        {/* Message list */}
        <div style={s.inboxPanel}>
          <div style={s.inboxHeader}>
            <span style={{ fontSize: '15px', fontWeight: '600' }}>Inbox</span>
            <span style={{ fontSize: '11px', color: '#4a5568', fontFamily: 'monospace' }}>
              {messages.length} messages · {unread} unread
            </span>
          </div>

          <div style={s.privacyBanner}>
            <span style={s.pDot} />
            Metadata shield active · IP masked · Timestamps obfuscated ±2h · Zero server logging
          </div>

          <div style={s.msgList}>
            {loading && <div style={s.empty}>Loading your inbox…</div>}

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
                  ...(msg.is_read ? {} : s.msgUnread),
                  ...(selected?.id === msg.id ? s.msgSelected : {}),
                }}
                onClick={() => openMessage(msg)}
              >
                <div style={{ ...s.msgAvatar, background: 'linear-gradient(135deg,#00e5a0,#0066ff)' }}>?</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: '3px' }}>
                    <span style={{ fontSize: '13px', fontWeight: msg.is_read ? 400 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {msg.sender_alias}
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
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

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
      {compose && <ComposeModal onClose={() => setCompose(false)} onSent={fetchInbox} />}

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
