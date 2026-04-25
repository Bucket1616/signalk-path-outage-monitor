# signalk-path-outage-monitor
SignalK plugin that can monitor up to 10 paths, each with it's own configurable timeout.
If this timeout elapses between messages log entries are made.

The intent of this is to log events where a NMEA message does not occur when expected.

For exmaple, when a NMEA sensor is suspected of having a problem, this can be employed and if the defined path
does not occur in [timeout] ms, an error is logged.

Since the NMEA bus may be powered off, which would not indicate the problem, a "keystone' path can be defined, 
which when it timesout indicates that the entire bus is down; making it much easier to search through logs to
see what was a true timeout and what was just the bus being powered off.

The timout period for the "Keystone path" may be longer than any of the monitored paths, so if a possible
outage is detected, the plugin will wait for Keystone-timeout time to make sure this isn't a bus power down
event.  Doing so prevents erroneous logs from being created when a bus is powered down.
