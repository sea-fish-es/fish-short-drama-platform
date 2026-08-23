'use client'

import { useState, useEffect } from 'react'
import { useAppStore } from '@/store'
import { scriptApi, getApiKeys } from '@/services/api.client'
import { generateOutline, generateExplainerMeta, parseOutlineResponse, ParsedOutline } from '@/services/script.client'
import { generateImage } from '@/services/agnes.client'
import { showAlert, showConfirm, showPrompt } from '@/components/common/Dialog'

export default function ScriptChat() {
  const { currentProject, messages, loading, progressMsg, genre, episodeCount, episodes, addMessage, setLoading, setProgressMsg, setEpisodes } = useAppStore()
  const [prompt, setPrompt] = useState('')
  const [scriptMode, setScriptMode] = useState<'ai' | 'own'>('ai')  // 科普：AI写稿 / 我给稿
  const hasOutline = episodes.length > 0
  const isExplainerProject = currentProject?.projectType === 'explainer'
  const useOwnScript = isExplainerProject && scriptMode === 'own'

  useEffect(() => {
    if (!loading) return
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [loading])

  const handleRegenerateOutline = async () => {
    if (!currentProject || loading) return
    const idea = prompt.trim() || (await showPrompt('输入新的故事想法（重新生成会清除现有全部内容）：', { title: '重新生成大纲' })) || ''
    if (!idea.trim()) return
    if (!(await showConfirm('确定重新生成大纲吗？当前所有剧集、场景、图片、视频将被清除。', { danger: true, confirmText: '重新生成' }))) return
    setPrompt(idea)
    // 清空前端剧集/场景，然后按新想法生成（后端 save 时会清除旧数据）
    setEpisodes([], '')
    await handleGenerate(idea)
  }

  const handleGenerate = async (overrideIdea?: string) => {
    const idea = (overrideIdea ?? prompt).trim()
    if (!idea || !currentProject) return
    if (hasOutline && !overrideIdea) return
    const apiKey = localStorage.getItem('agnes_api_key') || ''
    if (!apiKey) { showAlert('请先设置 API Key（点击右上角「API Key」按钮）'); return }
    setLoading(true)
    addMessage({ role: 'user', content: idea })
    try {
      const isVideo = currentProject.projectType === 'video'
      const isExplainer = currentProject.projectType === 'explainer'

      let parsed: ParsedOutline | null = null
      let outlineContent = ''

      if (isExplainer && scriptMode === 'own') {
        // 自带稿模式：AI 只提取标题/场景，原稿由前端原样注入
        setProgressMsg('正在分析稿件...')
        let meta: ParsedOutline | null = null
        for (let attempt = 0; attempt < 3; attempt++) {
          const metaJson = await generateExplainerMeta(idea, apiKey)
          try {
            const m = JSON.parse(metaJson.match(/\{[\s\S]*\}/)?.[0] || '{}')
            meta = {
              title: m.title || '未命名视频', synopsis: m.synopsis || '',
              totalEpisodes: 1, characters: [],
              locations: (m.locations || []).map((l: any) => ({ name: l.name || '', description: l.description || '', keywords: l.keywords || '' })),
              episodes: [],
            }
            break
          } catch { if (attempt >= 2) throw new Error('稿件分析失败，请重试') }
        }
        if (!meta) throw new Error('稿件分析失败')
        // 原稿逐字放入 episode.summary，标记 verbatim，切分镜时逐字保留
        parsed = {
          ...meta,
          episodes: [{ number: 1, title: meta.title, summary: idea }],
          verbatim: true,
        }
        outlineContent = JSON.stringify(parsed)
      } else {
        let genrePrefix = ''
        if (genre === 'auto') genrePrefix = (isVideo || isExplainer) ? '【请根据内容自动判断最适合的风格】' : '【请根据故事内容自动判断最适合的短剧类型风格】'
        else if (genre) genrePrefix = `【类型：${genre}风格】`
        const epCountPrefix = isExplainer
          ? '【这是一个完整的科普/口播视频，只有一集，全程画外音旁白解说，没有角色对白和剧情表演。请围绕主题生成完整、连贯、通俗的科普讲解内容】'
          : isVideo
          ? '【这是一个完整的长视频作品，只有一集，必须有完整的起承转合和明确结局，不留悬念】'
          : `【要求生成 ${episodeCount} 集】`
        const fullPrompt = `${genrePrefix}${epCountPrefix}${idea}`

        setProgressMsg('正在生成大纲...')
        for (let attempt = 0; attempt < 3; attempt++) {
          outlineContent = await generateOutline(fullPrompt, apiKey, currentProject.projectType)
          try { parsed = parseOutlineResponse(outlineContent); break } catch { if (attempt >= 2) throw new Error('大纲生成失败，请重试') }
        }
        if (!parsed) throw new Error('大纲生成失败')
      }

      if (!parsed) throw new Error('大纲生成失败')
      const outline = parsed

      setProgressMsg('正在保存大纲...')
      const result = await scriptApi.save({
        projectId: currentProject.id, outlineContent, parsed: outline,
        coverImage: null, characterImages: outline.characters.map(() => null), locationImages: outline.locations.map(() => null)
      })
      setEpisodes(result.episodes, result.scriptId)
      addMessage({ role: 'assistant', content: isExplainer ? '大纲/场景已就绪！' : `大纲生成完成！共 ${result.episodes.length} 集。` })

      const aspectRatio = currentProject.aspectRatio || '16:9'
      const coverSize = aspectRatio === '9:16' ? '768x1024' : aspectRatio === '1:1' ? '1024x1024' : '1024x768'
      const updateImage = (type: string, name: string, imageUrl: string) =>
        fetch('/api/asset/image', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey }, body: JSON.stringify({ projectId: currentProject.id, type, name, imageUrl }) })

      const keys = getApiKeys()
      const pool = keys.length > 0 ? keys : [apiKey]

      // Step A: 先生成角色 + 场景参考图（并行）
      type ImgTask = { type: string; name: string; prompt: string; size: string }
      const refTasks: ImgTask[] = [
        ...outline.characters.map(c => ({ type: 'character', name: c.name, prompt: `${c.keywords}，面朝镜头，半身像，中性背景`, size: '768x1024' })),
        ...outline.locations.map(l => ({ type: 'location', name: l.name, prompt: `${l.keywords}，广角镜头，电影感，无人物`, size: '1024x768' })),
      ]
      let nextIdx = 0
      let doneCount = 0
      const total = refTasks.length
      const charImages: Record<string, string> = {}  // name -> url，用于封面参考
      const imgWorker = async (key: string) => {
        while (true) {
          const idx = nextIdx++
          if (idx >= refTasks.length) return
          const t = refTasks[idx]
          try {
            const url = await generateImage(t.prompt, t.size, key)
            await updateImage(t.type, t.name, url)
            if (t.type === 'character') charImages[t.name] = url
          } catch {}
          doneCount++
          setProgressMsg(`正在生成角色/场景参考图 (${doneCount}/${total})...`)
        }
      }
      await Promise.all(pool.map(k => imgWorker(k)))

      // Step B: 用主要角色参考图 + 描述生成封面，保证封面人物形象一致
      setProgressMsg('正在生成封面...')
      try {
        const mainChars = parsed.characters.slice(0, 2).map(c => `${c.name}（${c.keywords}）`).join('，')
        const mainLoc = parsed.locations[0]?.keywords || ''
        const coverPrompt = `${parsed.title}，短剧封面海报，电影级构图，戏剧张力。主要角色：${mainChars}。场景氛围：${mainLoc}。海报风格，主角特写，标题感强，色彩浓烈`
        // 取前 2 个主要角色的参考图作为封面参考
        const refImages = parsed.characters.slice(0, 2).map(c => charImages[c.name]).filter(Boolean)
        const coverUrl = await generateImage(coverPrompt, coverSize, pool[0], refImages.length > 0 ? refImages : undefined)
        await updateImage('cover', '', coverUrl)
      } catch {}

      addMessage({ role: 'assistant', content: '所有参考图和封面生成完成！' })
      setPrompt('')
    } catch (e: any) {
      addMessage({ role: 'assistant', content: `错误: ${e.message}` })
      showAlert(`生成失败: ${e.message}`)
    }
    finally { setLoading(false); setProgressMsg('') }
  }

  const fillIdea = (text: string) => setPrompt(text)

  return (
    <>
      <div className="idea-header">
        <h3>{isExplainerProject ? (useOwnScript ? '粘贴稿件' : '主题构思') : '故事构思'}</h3>
        <div className="idea-sub">
          {isExplainerProject
            ? (useOwnScript ? '粘贴你写好的旁白稿，AI 自动切分镜、配画面、逐字朗读' : '给一个主题，AI 生成完整科普解说')
            : '写下你的创意，AI 生成完整大纲'}
        </div>
      </div>
      <div className="idea-body">
        {isExplainerProject && !hasOutline && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button
              className={scriptMode === 'ai' ? 'btn-accent' : 'btn-outline'}
              style={{ flex: 1, fontSize: 12, padding: '6px 0' }}
              onClick={() => setScriptMode('ai')} disabled={loading}>AI 写稿</button>
            <button
              className={scriptMode === 'own' ? 'btn-accent' : 'btn-outline'}
              style={{ flex: 1, fontSize: 12, padding: '6px 0' }}
              onClick={() => setScriptMode('own')} disabled={loading}>我来给稿</button>
          </div>
        )}
        {hasOutline ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--color-text-tertiary)' }}>
            <p style={{ fontSize: 14, marginBottom: 6 }}>✓ 大纲已生成</p>
            <p style={{ fontSize: 11 }}>共 {episodes.length} 集剧本大纲</p>
            <button className="btn-outline" style={{ marginTop: 14, fontSize: 12 }} disabled={loading}
              onClick={handleRegenerateOutline}>
              {loading ? '生成中...' : '重新生成大纲'}
            </button>
            <p style={{ fontSize: 10, marginTop: 8, color: 'var(--color-error)' }}>⚠ 会清除当前所有剧集、场景、图片和视频</p>
          </div>
        ) : (
          <>
            <textarea
              className="idea-textarea"
              style={useOwnScript ? { minHeight: 220 } : undefined}
              placeholder={
                useOwnScript
                  ? '粘贴你写好的完整旁白稿……\n\n例如：一辆失控电车即将撞死五人，你手边有扳手，可让电车变道撞死一人。拉，还是死一人；不拉，死五人……'
                  : isExplainerProject
                    ? '输入科普主题……\n\n例如：蜂蜜是如何产生的'
                    : '输入你的故事想法……\n\n例如：一个替身演员顶替当红女星出席豪门晚宴，却被总裁一眼看穿……'
              }
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              disabled={loading}
            />
            {!isExplainerProject && (
              <div className="idea-prompts">
                <button className="idea-prompt" onClick={() => fillIdea('一个替身演员被迫顶替当红女星，在豪门晚宴上遇到了识破她伪装的总裁。')}>替身 · 豪门</button>
                <button className="idea-prompt" onClick={() => fillIdea('都市白领意外穿越到古代宫廷，用现代知识在后宫杀出一条血路。')}>穿越 · 宫斗</button>
                <button className="idea-prompt" onClick={() => fillIdea('悬疑作家笔下的小说情节全部成真，而她成了连环命案的头号嫌疑人。')}>悬疑 · 反转</button>
              </div>
            )}
            {loading && (
              <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--color-accent-soft)', borderRadius: 'var(--radius-sm)', fontSize: 12, color: 'var(--color-accent)' }}>
                {progressMsg || '正在生成中……'}
              </div>
            )}
            {!loading && messages.length > 0 && messages.slice(-3).map((msg, i) => (
              <div key={i} style={{
                marginTop: 8, padding: '8px 12px', fontSize: 12, borderRadius: 'var(--radius-sm)',
                background: msg.content.startsWith('错误') ? 'var(--color-error-bg)' : 'var(--color-surface)',
                color: msg.content.startsWith('错误') ? 'var(--color-error)' : 'var(--color-text-secondary)',
              }}>
                {msg.content}
              </div>
            ))}
          </>
        )}
      </div>
      <div className="idea-footer">
        {!hasOutline && (
          <button className="btn-accent" onClick={() => handleGenerate()} disabled={loading || !prompt.trim()}>
            {loading ? '生成中...' : useOwnScript ? '⚡ 用我的稿子生成' : isExplainerProject ? '⚡ 生成科普内容' : '⚡ 生成完整大纲'}
          </button>
        )}
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', textAlign: 'center' }}>
          {useOwnScript
            ? 'AI 会按你的原稿切分镜并逐字朗读（仅轻微断句）'
            : isExplainerProject
              ? 'AI 将根据主题生成完整科普解说'
              : `AI 将根据你的创意自动生成 ${episodeCount || 15} 集剧本大纲`}
        </span>
      </div>
    </>
  )
}