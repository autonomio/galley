// Links: what a link names, and the one link for what is on screen.
import { describe, expect, it } from 'vitest'
import { landed, nextDocument, parseRoute, routeSearch } from '../../demo/route.js'

describe('parseRoute', () => {
  it('reads the document and the views open with it', () => {
    expect(parseRoute('?doc=trees&view=files+activity')).toEqual({ doc: 'trees', views: ['activity', 'files'] })
  })

  it('leaves out what it does not know', () => {
    expect(parseRoute('?doc=../etc&view=files,nope,files')).toEqual({ doc: null, views: ['files'] })
  })

  it('reads a bare address as no document and nothing open', () => {
    expect(parseRoute('')).toEqual({ doc: null, views: [] })
  })
})

describe('routeSearch', () => {
  it('writes one link for one screen, keeping the host its own parameters', () => {
    expect(routeSearch({ doc: 'trees', views: ['files', 'activity'] }, '?theme=light&doc=old&view=paper')).toBe('?doc=trees&view=activity+files&theme=light')
  })

  it('writes nothing for nothing', () => {
    expect(routeSearch({ doc: null, views: [] })).toBe('')
  })

  it('reads back as what it wrote', () => {
    expect(parseRoute(routeSearch({ doc: 'telco-48v', views: ['choices', 'writer'] }))).toEqual({ doc: 'telco-48v', views: ['writer', 'choices'] })
  })
})

describe('nextDocument', () => {
  it('keeps the views that follow the writer and closes the ones that belong to the document', () => {
    expect(nextDocument({ doc: 'a', views: ['activity', 'writer', 'paper', 'files'] }, 'b')).toEqual({ doc: 'b', views: ['activity', 'writer'] })
  })
})

describe('landed', () => {
  it('keeps the link as it was when its document opened', () => {
    expect(landed({ doc: 'a', views: ['writer', 'files'] }, 'a')).toEqual({ doc: 'a', views: ['writer', 'files'] })
  })

  it('opens none of a missing document\'s paper or files on the one that opened instead', () => {
    expect(landed({ doc: 'gone', views: ['writer', 'paper', 'files'] }, 'welcome')).toEqual({ doc: 'welcome', views: ['writer'] })
  })
})
