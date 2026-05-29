/**
 * TrackApplicationPage — deprecated (CLI 22).
 *
 * Post-submission tracking has moved into the wizard as Step 8 (Step8Status).
 * This page is kept to handle old /track/:token links from emails; it redirects
 * to /resume/:token so the wizard loads with the submitted session and lands on
 * Step 8 automatically.
 *
 * If no token is present, redirect to home.
 */
import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

export default function TrackApplicationPage() {
  const { token }  = useParams();
  const navigate   = useNavigate();

  useEffect(() => {
    if (token) {
      navigate('/resume/' + token, { replace: true });
    } else {
      navigate('/', { replace: true });
    }
  }, [token, navigate]);

  return null;
}
