-- Add onboarding_complete column to user_profiles
ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS onboarding_complete boolean DEFAULT false;

-- Mark all existing users as onboarding complete
-- so they don't see the wizard on next login
UPDATE user_profiles
SET onboarding_complete = true
WHERE onboarding_complete IS NULL OR onboarding_complete = false;
