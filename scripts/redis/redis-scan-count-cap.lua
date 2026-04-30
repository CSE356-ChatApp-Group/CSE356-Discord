-- redis-cli --eval redis-scan-count-cap.lua , '<pattern>' <cap>
-- Returns exact count if under cap, or '<cap>+' if truncated.
local pattern = ARGV[1]
local cap = tonumber(ARGV[2])
if not cap or cap < 1 then cap = 50000 end
local cursor = "0"
local total = 0
repeat
  local r = redis.call("SCAN", cursor, "MATCH", pattern, "COUNT", 2000)
  cursor = r[1]
  for _, k in ipairs(r[2]) do
    total = total + 1
    if total >= cap then
      return tostring(cap) .. "+"
    end
  end
until cursor == "0"
return tostring(total)
