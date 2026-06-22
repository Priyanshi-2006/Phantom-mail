import { useState, useEffect, useRef, useCallback } from 'react';
import api from '../utils/api';
import { 
  decryptGroupKey, 
  encryptGroupMessage, 
  decryptGroupMessage,
  generateGroupKey,
  encryptGroupKey,
  loadPrivateKey
} from '../utils/crypto';
import { getSocket } from '../utils/socket';
import CreateGroupModal from './CreateGroupModal';

export default function GroupPanel({ user, socketConnected }) {
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [messages, setMessages] = useState([]);
  const [groupDetails, setGroupDetails] = useState(null); // includes full members list
  const [inputText, setInputText] = useState('');
  
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [memberPresences, setMemberPresences] = useState({});
  const [newMemberAlias, setNewMemberAlias] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  // Key cache: Map<groupId:version, decryptedAesKeyB64>
  const groupKeys = useRef(new Map());

  // Refs for auto-scroll
  const messagesEndRef = useRef(null);

  const fetchGroups = useCallback(async () => {
    try {
      const res = await api.get('/groups/list');
      setGroups(res.data);
    } catch (err) {
      console.error('Failed to fetch groups:', err);
    } finally {
      setLoadingGroups(false);
    }
  }, []);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  // Load a group
  const openGroup = async (group) => {
    setSelectedGroup(group);
    setMessages([]);
    setGroupDetails(null);
    setLoadingMessages(true);
    setActionError('');
    setNewMemberAlias('');

    try {
      // 1. Fetch group details (members)
      const detailsRes = await api.get(`/groups/${group.id}`);
      setGroupDetails(detailsRes.data);

      // Fetch presences for all members
      const presences = {};
      await Promise.all(detailsRes.data.members.map(async (m) => {
        try {
          const presRes = await api.get(`/keys/presence/${m.member_alias}`);
          presences[m.member_alias] = presRes.data;
        } catch {
          presences[m.member_alias] = { online: false };
        }
      }));
      setMemberPresences(presences);

      // 2. Attempt to ensure we have the current group key decrypted in cache
      // If it fails, we catch it here so we don't skip loading the messages.
      try {
        await ensureKeyCached(group.id, group.current_key_version);
      } catch (keyErr) {
        console.warn('Could not cache current group key, messages will show decryption errors.');
      }

      // 3. Fetch messages
      const msgsRes = await api.get(`/groups/${group.id}/messages`);
      
      // 4. Decrypt messages
      const decryptedMsgs = await decryptMessagesBatch(msgsRes.data, group.id);
      setMessages(decryptedMsgs.reverse()); // Show oldest first (bottom up)

    } catch (err) {
      console.error('Failed to open group:', err);
      setActionError('Failed to load group. Check your keys.');
    } finally {
      setLoadingMessages(false);
    }
  };

  // Ensure a specific version of a group key is in cache
  const ensureKeyCached = async (groupId, version) => {
    const cacheKey = `${groupId}:${version}`;
    if (groupKeys.current.has(cacheKey)) return groupKeys.current.get(cacheKey);

    try {
      const res = await api.get(`/groups/${groupId}/key?version=${version}`);
      const privateKey = loadPrivateKey();
      if (!privateKey) throw new Error("Private key not found");
      
      const decryptedGroupKey = await decryptGroupKey(res.data.encrypted_group_key, privateKey);
      groupKeys.current.set(cacheKey, decryptedGroupKey);
      return decryptedGroupKey;
    } catch (err) {
      console.error(`Failed to get/decrypt group key for ${groupId} v${version}:`, err);
      throw err;
    }
  };

  // Batch decrypt messages, fetching older keys if needed
  const decryptMessagesBatch = async (encryptedMsgs, groupId) => {
    const results = [];
    for (const msg of encryptedMsgs) {
      try {
        const aesKey = await ensureKeyCached(groupId, msg.key_version);
        const decryptedText = await decryptGroupMessage(msg.body_encrypted, aesKey);
        results.push({ ...msg, body_decrypted: decryptedText });
      } catch (err) {
        results.push({ ...msg, body_decrypted: '⚠ Decryption failed (missing key)' });
      }
    }
    return results;
  };

  // Scroll to bottom when messages change
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Socket listeners
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !socketConnected) return;

    const onNewGroupMessage = async (msg) => {
      // Update last message time in list
      setGroups(prev => prev.map(g => 
        g.id === msg.group_id 
          ? { ...g, last_message_time: Math.max(g.last_message_time || 0, msg.created_at || Date.now()) }
          : g
      ).sort((a, b) => (b.last_message_time || b.created_at) - (a.last_message_time || a.created_at)));

      // If we are viewing this group, append it
      if (selectedGroup && selectedGroup.id === msg.group_id) {
        try {
          const aesKey = await ensureKeyCached(msg.group_id, msg.key_version);
          const decryptedText = await decryptGroupMessage(msg.body_encrypted, aesKey);
          setMessages(prev => [...prev, { ...msg, body_decrypted: decryptedText }]);
        } catch (err) {
          setMessages(prev => [...prev, { ...msg, body_decrypted: '⚠ Decryption failed' }]);
        }
      }
    };

    const onGroupAdded = (group) => {
      setGroups(prev => [group, ...prev]);
      socket.emit('join_group', group.id);
    };

    const onGroupRemoved = (data) => {
      setGroups(prev => prev.filter(g => g.id !== data.group_id));
      socket.emit('leave_group', data.group_id);
      if (selectedGroup && selectedGroup.id === data.group_id) {
        setSelectedGroup(null);
      }
    };

    const onGroupDissolved = (data) => {
      setGroups(prev => prev.filter(g => g.id !== data.group_id));
      if (selectedGroup && selectedGroup.id === data.group_id) {
        setSelectedGroup(null);
        alert(`Group "${data.name}" was dissolved by the creator.`);
      }
    };

    const onGroupKeyRotated = (data) => {
      // Clear all cached keys for this group (or at least the new version we don't have)
      // Actually, we don't need to proactively clear old versions, just update current_key_version
      setGroups(prev => prev.map(g => 
        g.id === data.group_id ? { ...g, current_key_version: data.new_key_version } : g
      ));
      if (selectedGroup && selectedGroup.id === data.group_id) {
        setSelectedGroup(prev => ({ ...prev, current_key_version: data.new_key_version }));
        // If we are the ones who got rotated out, we'd receive group_removed.
        // If we are still here, we can just wait to fetch the new key when a message arrives.
        // Or fetch details to update member list
        api.get(`/groups/${data.group_id}`).then(res => setGroupDetails(res.data)).catch(console.error);
      }
    };

    const onMemberAdded = (data) => {
      if (selectedGroup && selectedGroup.id === data.group_id) {
        api.get(`/groups/${data.group_id}`).then(res => setGroupDetails(res.data)).catch(console.error);
      }
      setGroups(prev => prev.map(g => 
        g.id === data.group_id ? { ...g, member_count: (g.member_count || 0) + 1 } : g
      ));
    };

    const onMemberLeft = (data) => {
      if (selectedGroup && selectedGroup.id === data.group_id) {
        api.get(`/groups/${data.group_id}`).then(res => setGroupDetails(res.data)).catch(console.error);
      }
      setGroups(prev => prev.map(g => 
        g.id === data.group_id ? { ...g, member_count: Math.max(0, (g.member_count || 1) - 1) } : g
      ));
    };

    socket.on('new_group_message', onNewGroupMessage);
    socket.on('group_added', onGroupAdded);
    socket.on('group_removed', onGroupRemoved);
    socket.on('group_dissolved', onGroupDissolved);
    socket.on('group_key_rotated', onGroupKeyRotated);
    socket.on('member_added', onMemberAdded);
    socket.on('member_left', onMemberLeft);

    return () => {
      socket.off('new_group_message', onNewGroupMessage);
      socket.off('group_added', onGroupAdded);
      socket.off('group_removed', onGroupRemoved);
      socket.off('group_dissolved', onGroupDissolved);
      socket.off('group_key_rotated', onGroupKeyRotated);
      socket.off('member_added', onMemberAdded);
      socket.off('member_left', onMemberLeft);
    };
  }, [socketConnected, selectedGroup]);

  const sendMessage = async () => {
    if (!inputText.trim() || !selectedGroup) return;
    const text = inputText;
    setInputText('');

    try {
      const aesKey = await ensureKeyCached(selectedGroup.id, selectedGroup.current_key_version);
      const encryptedJson = await encryptGroupMessage(text, aesKey);

      await api.post(`/groups/${selectedGroup.id}/send`, {
        body_encrypted: encryptedJson,
        key_version: selectedGroup.current_key_version
      });
    } catch (err) {
      console.error('Failed to send group message:', err);
      setActionError('Failed to send message.');
    }
  };

  const addMember = async () => {
    if (!newMemberAlias.trim()) return;
    setActionBusy(true);
    setActionError('');

    try {
      // Get current group key
      const aesKey = await ensureKeyCached(selectedGroup.id, selectedGroup.current_key_version);
      
      // Get new member's public key
      const res = await api.get(`/keys/${newMemberAlias.trim()}`);
      
      // Encrypt group key for new member
      const encryptedKeyForNewMember = await encryptGroupKey(aesKey, res.data.public_key);

      // Call API
      await api.post(`/groups/${selectedGroup.id}/members`, {
        alias: newMemberAlias.trim(),
        encrypted_group_key: encryptedKeyForNewMember
      });

      setNewMemberAlias('');
      // Details will update via socket event
    } catch (err) {
      setActionError(err.response?.data?.error || 'Failed to add member');
    } finally {
      setActionBusy(false);
    }
  };

  const removeMember = async (aliasToRemove) => {
    if (!window.confirm(`Remove ${aliasToRemove} from the group? This will rotate the group encryption key.`)) return;
    
    setActionBusy(true);
    setActionError('');

    try {
      // ATOMIC REMOVE + ROTATE
      // 1. Generate NEW group key
      const newGroupKey = await generateGroupKey();

      // 2. Get public keys for ALL remaining members (including self)
      const remainingMembers = groupDetails.members
        .filter(m => m.member_alias !== aliasToRemove)
        .map(m => m.member_alias);

      const newEncryptedKeys = {};
      for (const alias of remainingMembers) {
        if (alias === user.alias) {
          const meRes = await api.get('/auth/me');
          newEncryptedKeys[alias] = await encryptGroupKey(newGroupKey, meRes.data.public_key);
        } else {
          const res = await api.get(`/keys/${alias}`);
          newEncryptedKeys[alias] = await encryptGroupKey(newGroupKey, res.data.public_key);
        }
      }

      // 3. Call atomic delete endpoint
      const res = await api.delete(`/groups/${selectedGroup.id}/members/${aliasToRemove}`, {
        data: { new_encrypted_keys: newEncryptedKeys }
      });

      // 4. Update local cache with new key for new version
      const newVersion = res.data.new_key_version;
      groupKeys.current.set(`${selectedGroup.id}:${newVersion}`, newGroupKey);
      
      setSelectedGroup(prev => ({ ...prev, current_key_version: newVersion }));
      
      // Details will update via socket event, or we can fetch manually
      const detailsRes = await api.get(`/groups/${selectedGroup.id}`);
      setGroupDetails(detailsRes.data);

    } catch (err) {
      setActionError(err.response?.data?.error || 'Failed to remove member');
    } finally {
      setActionBusy(false);
    }
  };

  const leaveGroup = async () => {
    const msg = selectedGroup.creator_alias === user.alias
      ? "You are the creator. Leaving will DISSOLVE the group completely. Continue?"
      : "Leave this group? You won't be able to read new messages.";
    
    if (!window.confirm(msg)) return;

    try {
      await api.post(`/groups/${selectedGroup.id}/leave`);
      setGroups(prev => prev.filter(g => g.id !== selectedGroup.id));
      setSelectedGroup(null);
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to leave group');
    }
  };

  const formatTime = (ts) => {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60000)    return 'just now';
    if (diff < 3600000)  return `~${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `~${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  return (
    <div style={s.panelContainer}>
      
      {/* Left Column: Group List */}
      <div style={s.listColumn}>
        <div style={{ padding: '12px', borderBottom: '1px solid #232839' }}>
          <button style={s.newBtn} onClick={() => setShowCreateModal(true)}>
            + New Encrypted Group
          </button>
        </div>
        
        <div style={s.listScroll}>
          {loadingGroups && <div style={s.emptyList}>Loading groups...</div>}
          {!loadingGroups && groups.length === 0 && (
            <div style={s.emptyList}>You aren't in any groups yet.</div>
          )}
          {groups.map(g => (
            <div 
              key={g.id} 
              style={{ ...s.listItem, ...(selectedGroup?.id === g.id ? s.listItemSelected : {}) }}
              onClick={() => openGroup(g)}
            >
              <div style={s.listAvatar}>👥</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={s.listName}>{g.name}</div>
                <div style={s.listMeta}>
                  <span style={s.memberBadge}>{g.member_count || 0} members</span>
                  {g.last_message_time && <span>{formatTime(g.last_message_time)}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Center Column: Chat View */}
      <div style={s.chatColumn}>
        {!selectedGroup ? (
          <div style={s.emptyChat}>
            <div style={{ fontSize: '44px', marginBottom: '14px' }}>👥</div>
            <div style={{ color: '#4a5568', fontSize: '13px', textAlign: 'center', lineHeight: '1.8' }}>
              Select a group to view messages.<br/>
              <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>
                All group messages are E2E encrypted with AES-256-GCM.
              </span>
            </div>
          </div>
        ) : (
          <>
            {/* Chat Header */}
            <div style={s.chatHeader}>
              <div style={s.chatTitle}>{selectedGroup.name}</div>
              <div style={s.chatSubtitle}>
                E2E Encrypted Group · Key v{selectedGroup.current_key_version}
              </div>
            </div>

            {/* Messages Area */}
            <div style={s.messagesArea}>
              {loadingMessages ? (
                <div style={s.emptyChat}>Decrypting messages...</div>
              ) : messages.length === 0 ? (
                <div style={s.emptyChat}>No messages yet. Send the first one!</div>
              ) : (
                messages.map(msg => {
                  const isMine = msg.sender_alias === user.alias;
                  return (
                    <div key={msg.id} style={{ ...s.messageRow, justifyContent: isMine ? 'flex-end' : 'flex-start' }}>
                      <div style={{ ...s.messageBubble, ...(isMine ? s.bubbleMine : s.bubbleTheirs) }}>
                        {!isMine && <div style={s.messageSender}>{msg.sender_alias}</div>}
                        <div style={s.messageText}>{msg.body_decrypted}</div>
                        <div style={s.messageTime}>{formatTime(msg.approximate_time)}</div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div style={s.inputArea}>
              <input 
                style={s.messageInput}
                placeholder="Message group..."
                value={inputText}
                onChange={e => setInputText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
              />
              <button 
                style={s.sendBtn} 
                onClick={sendMessage}
                disabled={!inputText.trim()}
              >
                Encrypt & Send
              </button>
            </div>
          </>
        )}
      </div>

      {/* Right Column: Group Info */}
      {selectedGroup && groupDetails && (
        <div style={s.infoColumn}>
          <div style={s.infoHeader}>
            <div style={s.infoTitle}>{selectedGroup.name}</div>
            <div style={s.infoSubtitle}>Created by {selectedGroup.creator_alias}</div>
          </div>

          <div style={s.infoSection}>
            <div style={s.sectionTitle}>Members ({groupDetails.members.length}/{MAX_GROUP_MEMBERS})</div>
            <div style={s.memberList}>
              {groupDetails.members.map(m => {
                const isCreator = m.member_alias === selectedGroup.creator_alias;
                const isMe = m.member_alias === user.alias;
                const presence = memberPresences[m.member_alias] || {};
                
                return (
                  <div key={m.member_alias} style={s.infoMemberItem}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0 }}>
                      <span style={{ width: 6, height: 6, borderRadius: '50%', background: presence.online ? '#00e5a0' : '#4a5568', flexShrink: 0 }} />
                      <span style={s.infoMemberName} title={m.member_alias}>
                        {m.member_alias} {isMe && '(you)'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      {isCreator && <span title="Creator">👑</span>}
                      {/* Show remove button if I am creator, and this isn't me */}
                      {selectedGroup.creator_alias === user.alias && !isMe && (
                        <button 
                          style={s.removeMemberBtn} 
                          onClick={() => removeMember(m.member_alias)}
                          disabled={actionBusy}
                          title="Remove member (rotates group key)"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {selectedGroup.creator_alias === user.alias && (
            <div style={s.infoSection}>
              <div style={s.sectionTitle}>Add Member</div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input 
                  style={s.addMemberInput}
                  placeholder="alias"
                  value={newMemberAlias}
                  onChange={e => setNewMemberAlias(e.target.value)}
                  disabled={actionBusy || groupDetails.members.length >= MAX_GROUP_MEMBERS}
                />
                <button 
                  style={s.addMemberBtn}
                  onClick={addMember}
                  disabled={actionBusy || !newMemberAlias.trim() || groupDetails.members.length >= MAX_GROUP_MEMBERS}
                >
                  Add
                </button>
              </div>
            </div>
          )}

          {actionError && <div style={s.actionError}>{actionError}</div>}

          <div style={{ marginTop: 'auto', padding: '16px' }}>
            <div style={s.securityBadge}>
              🔒 AES-256-GCM<br/>
              Key Version: {selectedGroup.current_key_version}
            </div>
            <button style={s.leaveBtn} onClick={leaveGroup}>
              {selectedGroup.creator_alias === user.alias ? 'Dissolve Group' : 'Leave Group'}
            </button>
          </div>
        </div>
      )}

      {showCreateModal && (
        <CreateGroupModal 
          onClose={() => setShowCreateModal(false)} 
          onCreated={fetchGroups} 
        />
      )}
    </div>
  );
}

const MAX_GROUP_MEMBERS = 50;

const s = {
  panelContainer: { display: 'flex', flex: 1, overflow: 'hidden' },
  
  // Left Column
  listColumn: { width: '220px', background: '#111318', borderRight: '1px solid #232839', display: 'flex', flexDirection: 'column', flexShrink: 0 },
  newBtn: { width: '100%', background: '#00e5a0', color: '#000', border: 'none', borderRadius: '6px', padding: '8px', fontSize: '12px', fontWeight: '700', cursor: 'pointer', fontFamily: 'inherit' },
  listScroll: { flex: 1, overflowY: 'auto' },
  emptyList: { padding: '20px', textAlign: 'center', color: '#4a5568', fontSize: '12px' },
  listItem: { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px', borderBottom: '1px solid rgba(35,40,57,0.5)', cursor: 'pointer', transition: 'background 0.1s' },
  listItemSelected: { background: '#1e2330' },
  listAvatar: { width: 28, height: 28, borderRadius: '6px', background: 'rgba(0,102,255,0.1)', color: '#6a9fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', flexShrink: 0 },
  listName: { fontSize: '13px', fontWeight: '500', color: '#e8eaf0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: '4px' },
  listMeta: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#8892a4', fontFamily: 'monospace' },
  memberBadge: { background: 'rgba(255,255,255,0.05)', padding: '1px 4px', borderRadius: '3px' },

  // Center Column
  chatColumn: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0a0b0e' },
  emptyChat: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '30px', color: '#4a5568' },
  chatHeader: { padding: '12px 20px', background: '#111318', borderBottom: '1px solid #232839', flexShrink: 0 },
  chatTitle: { fontSize: '15px', fontWeight: '600', color: '#e8eaf0', marginBottom: '4px' },
  chatSubtitle: { fontSize: '11px', color: '#00e5a0', fontFamily: 'monospace' },
  messagesArea: { flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' },
  messageRow: { display: 'flex', width: '100%' },
  messageBubble: { maxWidth: '75%', padding: '10px 14px', borderRadius: '12px', position: 'relative' },
  bubbleMine: { background: 'rgba(0,229,160,0.1)', border: '1px solid rgba(0,229,160,0.2)', borderBottomRightRadius: '4px' },
  bubbleTheirs: { background: '#171b22', border: '1px solid #232839', borderBottomLeftRadius: '4px' },
  messageSender: { fontSize: '10px', color: '#00e5a0', fontFamily: 'monospace', marginBottom: '4px', textTransform: 'uppercase' },
  messageText: { fontSize: '13px', color: '#e8eaf0', lineHeight: '1.5', whiteSpace: 'pre-wrap' },
  messageTime: { fontSize: '9px', color: '#8892a4', fontFamily: 'monospace', textAlign: 'right', marginTop: '6px' },
  inputArea: { padding: '16px 20px', background: '#111318', borderTop: '1px solid #232839', display: 'flex', gap: '12px', flexShrink: 0 },
  messageInput: { flex: 1, background: '#171b22', border: '1px solid #232839', borderRadius: '8px', padding: '12px 14px', color: '#e8eaf0', fontSize: '13px', fontFamily: 'inherit', outline: 'none' },
  sendBtn: { background: '#00e5a0', color: '#000', border: 'none', borderRadius: '8px', padding: '0 16px', fontWeight: '600', fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' },

  // Right Column
  infoColumn: { width: '260px', background: '#111318', borderLeft: '1px solid #232839', display: 'flex', flexDirection: 'column', flexShrink: 0 },
  infoHeader: { padding: '16px', borderBottom: '1px solid #232839' },
  infoTitle: { fontSize: '14px', fontWeight: '600', color: '#e8eaf0', marginBottom: '4px' },
  infoSubtitle: { fontSize: '11px', color: '#8892a4', fontFamily: 'monospace' },
  infoSection: { padding: '16px', borderBottom: '1px solid #232839' },
  sectionTitle: { fontSize: '11px', fontFamily: 'monospace', color: '#4a5568', textTransform: 'uppercase', marginBottom: '10px', letterSpacing: '0.5px' },
  memberList: { display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' },
  infoMemberItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px', padding: '6px 8px', background: '#171b22', borderRadius: '6px', border: '1px solid #232839' },
  infoMemberName: { color: '#e8eaf0', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  removeMemberBtn: { background: 'none', border: 'none', color: '#ff8888', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '0 4px' },
  addMemberInput: { flex: 1, background: '#171b22', border: '1px solid #232839', borderRadius: '4px', padding: '6px 8px', color: '#e8eaf0', fontSize: '12px', outline: 'none', minWidth: 0 },
  addMemberBtn: { background: 'rgba(0,229,160,0.1)', color: '#00e5a0', border: '1px solid rgba(0,229,160,0.3)', borderRadius: '4px', padding: '0 10px', fontSize: '11px', cursor: 'pointer' },
  actionError: { margin: '16px 16px 0', padding: '8px', background: 'rgba(255,136,136,0.1)', color: '#ff8888', fontSize: '11px', borderRadius: '4px', border: '1px solid rgba(255,136,136,0.2)' },
  securityBadge: { background: 'rgba(0,102,255,0.05)', border: '1px solid rgba(0,102,255,0.2)', padding: '10px', borderRadius: '6px', color: '#6a9fff', fontSize: '10px', fontFamily: 'monospace', textAlign: 'center', marginBottom: '12px', lineHeight: '1.6' },
  leaveBtn: { width: '100%', background: 'rgba(255,136,136,0.1)', border: '1px solid rgba(255,136,136,0.3)', color: '#ff8888', padding: '10px', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' },
};
