import type { ProjectStatus } from '../../../contracts/project-progress';
import { validReadingPosition } from '../../../contracts/screen-checkpoint';

function documentKey(title?: string) {
  return title?.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

export function readingLocation(status?: ProjectStatus) {
  const paper = status?.latestPaper;
  const legacy = status?.readingPosition;
  const storedBookmark = status?.readingBookmark;
  const title = paper?.title ?? legacy?.document ?? storedBookmark?.current.document;
  const candidate = paper ? paper.position : legacy;
  const position = validReadingPosition(candidate) ? candidate : undefined;
  const bookmark = !paper || documentKey(storedBookmark?.current.document) === documentKey(paper.title)
    ? storedBookmark : undefined;
  const samePage = !paper || (documentKey(legacy?.document) === documentKey(paper.title) &&
    position && legacy && legacy.page === position.page && legacy.total === position.total);
  return { title, position, bookmark, pageSection: samePage ? legacy?.section : undefined };
}
