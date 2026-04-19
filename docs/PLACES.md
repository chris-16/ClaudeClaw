# Places - Semantic Location Tracking

The Places system extends OwnTracks location tracking with semantic location awareness. Instead of just tracking coordinates, the system can recognize "where" you are in a meaningful way (Home, Office, Gym, etc.).

## How It Works

1. **OwnTracks** sends location pings (coordinates) to the ClaudeClaw backend
2. **Places database** stores known locations with names, coordinates, and radius
3. **Automatic matching**: When a location ping arrives, it's matched against known places
4. **Semantic awareness**: The system knows "Chris is at Home" instead of just "Chris is at -33.4489, -70.6693"

## Auto-Creation from Regions

When you create a **region** in the OwnTracks app (e.g., "Home", "Gym", "Office"), the first time you enter or leave that region, ClaudeClaw automatically creates a corresponding place in the database.

This means:
- Create regions in OwnTracks app
- Enter/leave the region once
- The place is automatically saved with a 100m default radius
- Future location pings will match against this place

## Managing Places via CLI

```bash
# List all known places
node dist/places-cli.js list

# Add a new place
node dist/places-cli.js add "Home" -33.4489 -70.6693 --radius 150 --type home --city Santiago

# Add a place with full details
node dist/places-cli.js add "Hotel Eurobuilding" 10.4826 -66.8502 \
  --radius 100 \
  --type hotel \
  --city Caracas \
  --country Venezuela

# Get details of a place
node dist/places-cli.js get home

# Delete a place
node dist/places-cli.js delete hotel-eurobuilding
```

## Place Types

Common types (you can use any string):
- `home` - Your residence
- `work` - Office or workplace
- `gym` - Fitness center
- `hotel` - Temporary accommodation
- `restaurant` - Dining location
- `friend` - Friend's place
- `family` - Family member's place

## Database Schema

```sql
CREATE TABLE places (
  id          TEXT PRIMARY KEY,      -- Normalized name (e.g., "hotel-eurobuilding")
  name        TEXT NOT NULL,         -- Display name (e.g., "Hotel Eurobuilding")
  lat         REAL NOT NULL,         -- Latitude
  lon         REAL NOT NULL,         -- Longitude
  radius      INTEGER DEFAULT 100,   -- Radius in meters
  type        TEXT,                  -- Place type (home, work, gym, etc.)
  city        TEXT,                  -- City name
  country     TEXT,                  -- Country name
  metadata    TEXT,                  -- Additional JSON metadata
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
```

## Location Matching Logic

When a location ping arrives:

1. Check if OwnTracks sent a region name → use that
2. Check if OwnTracks sent `inregions` array → use first match
3. **Fall back to places database**: Calculate distance from ping to all known places
   - If within radius → match the closest place
   - If no match → region is `null` (shown as "Out" in UI)

This creates a hierarchy:
- OwnTracks regions (highest priority)
- Places database (fallback)
- Out/unknown (no match)

## Reverse Geocoding (Future Enhancement)

The system is designed to optionally support reverse geocoding APIs:
- When in an unknown location, call geocoding API (e.g., Nominatim)
- Cache the result in the places database
- Future visits to that area auto-match against the cached place

This hasn't been implemented yet but the architecture supports it.

## Use Cases

### Location-based Reminders
"When Chris arrives at Office → remind about 3pm meeting"

### Context-aware Nudges
"Chris left Gym → ask if workout was logged"

### Travel Tracking
"Chris is at Hotel Eurobuilding in Caracas → adjust timezone for reminders"

### Habit Tracking
"Chris went to Gym 4 times this week"

### Multi-city Awareness
The system automatically tracks which city/country you're in based on matched places, useful for travelers.

## Privacy

All location data stays local in your SQLite database. No external APIs are called by default. Reverse geocoding (when implemented) will be opt-in.
