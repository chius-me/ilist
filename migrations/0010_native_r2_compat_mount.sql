INSERT INTO mounts (
  id,
  name,
  mount_path,
  driver_type,
  provider,
  enabled,
  is_public,
  sort_order,
  root_item_id,
  config_json,
  created_at,
  updated_at
)
SELECT
  'native-r2',
  'R2',
  '/R2',
  'native-r2',
  'cloudflare-r2',
  1,
  1,
  0,
  'root',
  '{}',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM mounts WHERE id = 'native-r2'
);
