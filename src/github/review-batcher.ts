import { chunkArray, sortCommentsDeterministically } from '../domain/post-comments.ts';
import type { Comment } from '../types/github.ts';

/** Sort comments deterministically before partitioning into batches. */
export const sortAndBatchComments = (
  comments: readonly Comment[],
  batchSize: number,
): Comment[][] => {
  const sorted = sortCommentsDeterministically(comments);
  return chunkArray(sorted, batchSize);
};
