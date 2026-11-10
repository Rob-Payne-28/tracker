import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { api, type Story } from '../api';
import { ErrorText, Spinner } from '../components/ui';

/** /stories/:id → /projects/:project_id/stories/:id */
export function StoryRedirect() {
  const { storyId } = useParams();
  const [story, setStory] = useState<Story | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<Story>(`/stories/${storyId}`).then(setStory).catch(setError);
  }, [storyId]);
  if (story) return <Navigate to={`/projects/${story.project_id}/stories/${story.id}`} replace />;
  return <div className="page">{error ? <ErrorText error={error} /> : <Spinner />}</div>;
}
