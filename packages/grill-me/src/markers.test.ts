import { describe, expect, it } from 'vitest';
import { createMarkerParser } from './markers';

describe('marker parser', () => {
  it('emits plain text as tokens', () => {
    const parser = createMarkerParser();

    expect(parser.push('Thinking about your idea… ')).toEqual([
      { kind: 'token', text: 'Thinking about your idea… ' },
    ]);
  });

  it('emits a question block once its closing marker arrives', () => {
    const parser = createMarkerParser();

    expect(parser.push('<QUESTION>Which database?')).toEqual([]);
    expect(parser.push('</QUESTION>')).toEqual([
      { kind: 'block', type: 'QUESTION', content: 'Which database?' },
    ]);
  });

  it('emits text before a marker as a token, then the block', () => {
    const parser = createMarkerParser();

    expect(parser.push('Sure. <QUESTION>Which database?</QUESTION>')).toEqual([
      { kind: 'token', text: 'Sure. ' },
      { kind: 'block', type: 'QUESTION', content: 'Which database?' },
    ]);
  });

  it('never leaks a partial opening marker as a token', () => {
    const parser = createMarkerParser();

    expect(parser.push('Pick one: <QUES')).toEqual([{ kind: 'token', text: 'Pick one: ' }]);
    expect(parser.push('TION>SQL or NoSQL?</QUESTION>')).toEqual([
      { kind: 'block', type: 'QUESTION', content: 'SQL or NoSQL?' },
    ]);
  });

  it('recognises plan and issues blocks', () => {
    const parser = createMarkerParser();

    expect(parser.push('<PLAN># Plan\n\n- step</PLAN>')).toEqual([
      { kind: 'block', type: 'PLAN', content: '# Plan\n\n- step' },
    ]);
    expect(parser.push('<ISSUES>[{"title":"A"}]</ISSUES>')).toEqual([
      { kind: 'block', type: 'ISSUES', content: '[{"title":"A"}]' },
    ]);
  });

  it('parses adjacent blocks in one chunk without merging them', () => {
    const parser = createMarkerParser();

    expect(parser.push('<PLAN>P</PLAN><ISSUES>[]</ISSUES>')).toEqual([
      { kind: 'block', type: 'PLAN', content: 'P' },
      { kind: 'block', type: 'ISSUES', content: '[]' },
    ]);
  });

  it('flushes buffered text, including an unterminated block, as a token', () => {
    const parser = createMarkerParser();

    expect(parser.push('partial <QUESTION>unfinished')).toEqual([
      { kind: 'token', text: 'partial ' },
    ]);
    expect(parser.flush()).toEqual([{ kind: 'token', text: '<QUESTION>unfinished' }]);
  });
});
