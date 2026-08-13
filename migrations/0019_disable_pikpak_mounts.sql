UPDATE mounts
SET enabled = 0,
    is_public = 0,
    updated_at = CURRENT_TIMESTAMP
WHERE driver_type = 'pikpak';
