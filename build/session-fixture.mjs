/** Small official-log fixture shared by session persistence checks. */
export function sessionFixture(workspacePath) {
  const stored = new Map(), live = new Map(), images = new Map(), calls = { create: [], resume: [], attach: [], admit: [], controllerCreate: [], resolve: [], prompt: [], selectModel: [], dispose: [] }
  function handle(id) {
    const listeners = new Map()
    const agent = {
      id, session: { id, seq: 0 }, status: 'idle', presetMounted: true,
      ctx: { on(name, listener) { const list = listeners.get(name) ?? []; list.push(listener); listeners.set(name, list); return () => list.splice(list.indexOf(listener), 1) } },
      followup(message) {
        for (const listener of listeners.get('agent/inbox/inserted') ?? []) listener({ message })
        agent.status = 'running'
        for (const listener of listeners.get('agent/status') ?? []) listener({ agent, status: 'running' })
        const record = stored.get(id), events = record.events
        const add = (type, data, surface = false) => events.push({ type, data, seq: events.length, time: Date.now(), ...(surface ? { surfaceOp: 'append' } : {}) })
        add('turn/start', {})
        add('user/message', message, true)
        for (const listener of listeners.get('agent/assistant-stream') ?? []) listener({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '你好' } } })
        add('assistant/message', { message: { id: `answer-${events.length}`, content: [{ type: 'text', text: '你好' }] } }, true)
        add('turn/end', { reason: { kind: 'completed' } })
        agent.session.seq = events.length - 1
        agent.status = 'idle'
        for (const listener of listeners.get('agent/status') ?? []) listener({ agent, status: 'idle' })
      },
      cancel() { agent.status = 'idle' }, async whenIdle() {},
    }
    live.set(id, agent)
    return { agent, async dispose() { calls.dispose.push(id); live.delete(id) } }
  }
  const ctx = {
    messageFeedback: {
      async list({sessionId}) { return {ok:true,value:{items:stored.get(sessionId).events.filter(e=>e.type==='feedback/message-put').map(e=>e.data.item)}} },
      async put(request) { const record=stored.get(request.sessionId); const item={messageId:request.messageId,version:'fixture-feedback',rating:request.rating,note:request.note};record.events.push({type:'feedback/message-put',seq:record.events.length,time:Date.now(),data:{sessionId:request.sessionId,item}});return {ok:true,value:item} },
    },
    attachments: {
      async admitPromptContent(content) {
        if (content.some(part => part.type === 'image')) calls.admit.push(content)
        return content.map(part => {
          if (part.type !== 'image') return part
          const data = Buffer.from(part.data, 'base64')
          if (data.toString('base64') !== part.data || !data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('invalid image')
          const ref = { attachmentId: 'fixture-image', mediaType: 'image/png', width: 1, height: 1, bytes: data.length, name: part.name }
          images.set(ref.attachmentId, { ref, data })
          return { type: 'image', attachment: ref }
        })
      },
      async readImage(ref) { const image = images.get(ref.attachmentId); if(!image)throw new Error('missing image'); return image },
    },
    agents: {
      async create(options) { calls.create.push(options); if (stored.has(options.sessionId)) throw new Error('duplicate'); stored.set(options.sessionId, { meta: { id: options.sessionId, cwd: options.meta.cwd, createdAt: Date.now() }, events: [] }); return handle(options.sessionId) },
      async resume(options) { calls.resume.push(options); if (!stored.has(options.resumeSessionId)) throw new Error('missing'); return handle(options.resumeSessionId) },
      get(id) { return live.get(id) },
    },
    sessionController: {
      async inspect(id) { const record = stored.get(id); if (!record) throw new Error('session missing'); return record },
      async create(request) {
        calls.controllerCreate.push(request)
        if (request.workspaceId !== 'quick-workspace') throw new Error('wrong workspace identity')
        if (!stored.has(request.sessionId)) await ctx.agents.create({ sessionId: request.sessionId, meta: { cwd: workspacePath, agentPreset: 'standard' }, setup: 'preset-mounted' })
        const record = stored.get(request.sessionId)
        if (record.meta.cwd !== workspacePath) throw new Error('cwd mismatch')
        calls.attach.push(request.sessionId)
        return { sessionId: request.sessionId, agentPreset: 'standard' }
      },
      async resolveAgent(id) {
        calls.resolve.push(id)
        if (!stored.has(id)) return { error: Object.assign(new Error('session missing'), { code: 'session/not-found' }) }
        const agent = live.get(id) ?? (await ctx.agents.resume({ resumeSessionId: id, setup: 'preset-mounted' })).agent
        return { agent }
      },
      async prompt(request, signal) {
        signal.throwIfAborted()
        calls.prompt.push(request)
        const resolved = await this.resolveAgent(request.sessionId)
        if ('error' in resolved) throw resolved.error
        const content = await ctx.attachments.admitPromptContent(request.content)
        resolved.agent.followup({ id: request.requestId, role: 'user', content, source: { kind: 'user', rpcId: request.requestId } })
        return { accepted: true }
      },
      async selectModel(request) {
        calls.selectModel.push(request)
        const resolved = await this.resolveAgent(request.sessionId)
        if ('error' in resolved) throw resolved.error
        resolved.agent.options = { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort }
        return { selected: request }
      },
    },
    workspaceRegistry: { async create(path) { if (path !== workspacePath) throw new Error('wrong workspace path'); return { id: 'quick-workspace', path, async attachSession(id) { if (stored.get(id)?.meta.cwd !== path) throw new Error('cwd mismatch'); calls.attach.push(id) } } } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'provider', model: 'default-model' }) },
  }
  return { ctx, calls, stored, live }
}
