(() => {
  const now = Date.now()
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString()
  const seed = {
    currentUser: { id: 'user-lin', username: 'Lin', displayName: 'Lin', status: 'online', avatar: 'L' },
    servers: [
      { id: 'server-squad', name: '游戏小队', initials: 'GG', color: 'purple', unread: 2 },
      { id: 'server-weekend', name: '周末计划', initials: '末', color: 'coral', unread: 0 },
    ],
    channels: [
      { id: 'text-chat', serverId: 'server-squad', name: '闲聊', type: 'text', topic: '今晚也要玩得开心', unread: 2 },
      { id: 'text-party', serverId: 'server-squad', name: '游戏组队', type: 'text', topic: '组队、开黑、约时间', unread: 0 },
      { id: 'text-clips', serverId: 'server-squad', name: '战绩分享', type: 'text', topic: '高光时刻请发这里', unread: 0 },
      { id: 'voice-lobby', serverId: 'server-squad', name: '开黑大厅', type: 'voice', topic: '语音房间', unread: 0 },
      { id: 'text-chat-weekend', serverId: 'server-weekend', name: '周末安排', type: 'text', topic: '计划下一次聚会', unread: 1 },
      { id: 'voice-weekend', serverId: 'server-weekend', name: '一起玩', type: 'voice', topic: '语音房间', unread: 0 },
    ],
    members: [
      { id: 'user-mori', displayName: 'Mori', username: 'mori', status: 'online', activity: '正在玩 Valorant', avatar: '森', color: 'violet' },
      { id: 'user-kira', displayName: 'Kira', username: 'kira', status: 'online', activity: '在语音 · 开黑大厅', avatar: 'K', color: 'orange' },
      { id: 'user-ache', displayName: '阿澈', username: 'ache', status: 'idle', activity: '暂时离开', avatar: '澈', color: 'green' },
    ],
    messages: {
      'text-chat': [
        { id: 'm-1', channelId: 'text-chat', authorId: 'user-mori', author: 'Mori', avatar: '森', color: 'violet', createdAt: ago(48), content: '晚上好，今晚打什么？我刚把更新下完了 🎮', pinned: false, reactions: [{ emoji: '🎮', count: 2, reacted: false }] },
        { id: 'm-2', channelId: 'text-chat', authorId: 'user-kira', author: 'Kira', avatar: 'K', color: 'orange', createdAt: ago(46), content: '先来两把无畏契约？阿澈说他十分钟后到。', pinned: false, reactions: [] },
        { id: 'm-3', channelId: 'text-chat', authorId: 'user-lin', author: 'Lin', avatar: 'L', color: 'blue', createdAt: ago(45), content: '可以，我开个语音房，等人齐了就开。', pinned: true, reactions: [{ emoji: '👍', count: 1, reacted: true }] },
        { id: 'm-4', channelId: 'text-chat', authorId: 'user-mori', author: 'Mori', avatar: '森', color: 'violet', createdAt: ago(44), content: '好，今天争取别再输加时了 😂', pinned: false, reactions: [] },
      ],
      'text-party': [{ id: 'p-1', channelId: 'text-party', authorId: 'user-kira', author: 'Kira', avatar: 'K', color: 'orange', createdAt: ago(180), content: '今晚 9 点排位，缺一个人，来吗？', pinned: true, reactions: [{ emoji: '🙋', count: 2, reacted: false }] }],
      'text-clips': [{ id: 'c-1', channelId: 'text-clips', authorId: 'user-mori', author: 'Mori', avatar: '森', color: 'violet', createdAt: ago(1400), content: '昨天最后一回合的残局，差一点就五杀了。', pinned: false, reactions: [{ emoji: '🔥', count: 3, reacted: false }] }],
      'text-chat-weekend': [{ id: 'w-1', channelId: 'text-chat-weekend', authorId: 'user-ache', author: '阿澈', avatar: '澈', color: 'green', createdAt: ago(75), content: '周六下午大家有空吗？可以约个饭再打游戏。', pinned: false, reactions: [] }],
    },
  }
  window.EchoFixtures = seed
})()
